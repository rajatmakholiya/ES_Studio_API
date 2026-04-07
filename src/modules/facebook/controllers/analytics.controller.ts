import { Controller, Get, Param, Query, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Between, MoreThanOrEqual, LessThan } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { DemographicSnapshot } from '../entities/DemographicSnapshot.entity';
import {
  fetchProfileBasics,
  fetchDailySnapshot,
  fetchPostsPaginated,
  fetchPostDeepInsights,
  fetchDemographics,
  fetchDailyRevenue,
} from '../services/meta.service';

/** Safety cap for profileIds arrays to avoid unbounded IN clauses */
const MAX_PROFILE_IDS = 50;
const DEBUG_LIMIT = 200;

@Controller('api/analytics')
export class AnalyticsController {
  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialPost) private postRepo: Repository<SocialPost>,
    @InjectRepository(DemographicSnapshot)
    private demographicRepo: Repository<DemographicSnapshot>,
    @InjectQueue('social-sync-queue') private syncQueue: Queue,
  ) {}

  @Get('profiles/list')
  async getConnectedProfiles(@Res() res: Response) {
    const profiles = await this.profileRepo.find({
      where: { isActive: true },
      select: ['profileId', 'name', 'platform', 'syncState', 'lastSyncError'],
    });
    return res.status(200).json(profiles);
  }

  @Get('demographics/:profileId')
  async getDemographics(
    @Param('profileId') profileId: string,
    @Res() res: Response,
  ) {
    try {
      const demo = await this.demographicRepo.findOne({
        where: { profileId },
        order: { date: 'DESC' },
      });

      if (!demo) {
        return res.status(200).json({
          genderAge: {},
          topCities: {},
          topCountries: {},
        });
      }

      return res.status(200).json({
        genderAge: demo.genderAge || {},
        topCities: demo.topCities || {},
        topCountries: demo.topCountries || {},
        date: demo.date,
        platform: demo.platform,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * OPTIMIZED: Replaced N+1 loop with a single DISTINCT ON query that fetches
   * the latest demographic row per profile in one round-trip.
   */
  @Post('demographics/aggregate')
  async getAggregatedDemographics(
    @Body() body: { profileIds: string[] },
    @Res() res: Response,
  ) {
    try {
      const { profileIds } = body;
      if (!profileIds || profileIds.length === 0) {
        return res.status(200).json({
          genderAge: {},
          topCities: {},
          topCountries: {},
        });
      }

      const safeIds = profileIds.slice(0, MAX_PROFILE_IDS);

      // Single query: get latest demographic per profile using DISTINCT ON
      const latestDemos: DemographicSnapshot[] = await this.demographicRepo
        .createQueryBuilder('d')
        .where(
          'd."profileId" IN (:...ids)',
          { ids: safeIds },
        )
        .andWhere(
          `d.id IN (
            SELECT DISTINCT ON (sub."profileId") sub.id
            FROM demographic_snapshots sub
            WHERE sub."profileId" IN (:...ids)
            ORDER BY sub."profileId", sub.date DESC
          )`,
          { ids: safeIds },
        )
        .getMany();

      const aggregated = {
        genderAge: {} as Record<string, number>,
        topCities: {} as Record<string, number>,
        topCountries: {} as Record<string, number>,
      };

      for (const demo of latestDemos) {
        if (demo.genderAge) {
          for (const [key, val] of Object.entries(demo.genderAge)) {
            aggregated.genderAge[key] =
              (aggregated.genderAge[key] || 0) + Number(val);
          }
        }
        if (demo.topCities) {
          for (const [key, val] of Object.entries(demo.topCities)) {
            aggregated.topCities[key] =
              (aggregated.topCities[key] || 0) + Number(val);
          }
        }
        if (demo.topCountries) {
          for (const [key, val] of Object.entries(demo.topCountries)) {
            aggregated.topCountries[key] =
              (aggregated.topCountries[key] || 0) + Number(val);
          }
        }
      }

      return res.status(200).json(aggregated);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * OPTIMIZED: Aggregate snapshots and posts at DB level instead of loading
   * all rows into memory. Only the latest snapshot + aggregated totals are fetched.
   */
  @Get(':profileId/data')
  async getSmartAnalytics(
    @Param('profileId') profileId: string,
    @Query('days') daysStr: string,
    @Res() res: Response,
  ) {
    try {
      const days = Math.min(parseInt(daysStr) || 30, 365);
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days);
      const startStr = start.toISOString().split('T')[0];

      const profile = await this.profileRepo.findOne({ where: { profileId } });
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      // DB-level aggregation for total engagements from posts
      const postAgg: { totalEngagements: string } | undefined =
        await this.postRepo
          .createQueryBuilder('p')
          .select(
            'COALESCE(SUM(p.likes + p.comments + p.shares + p.clicks), 0)',
            'totalEngagements',
          )
          .where('p."profileId" = :profileId', { profileId })
          .andWhere('p."postedAt" >= :start', { start })
          .getRawOne();

      const totalEngagements = Number(postAgg?.totalEngagements || 0);

      // Latest follower count (single row)
      const absoluteLatestSnap = await this.snapshotRepo.findOne({
        where: { profileId },
        order: { date: 'DESC' },
        select: ['totalFollowers'],
      });
      const followers = absoluteLatestSnap
        ? absoluteLatestSnap.totalFollowers
        : 0;

      const engRate =
        followers > 0
          ? ((totalEngagements / followers) * 100).toFixed(2) + '%'
          : '0.00%';

      // Snapshots: still needed for the chart, but bounded by days
      const dailySnapshots = await this.snapshotRepo.find({
        where: { profileId, date: MoreThanOrEqual(startStr) },
        order: { date: 'ASC' },
      });

      // Posts: bounded by date range, limited to 500 for safety
      const recentPosts = await this.postRepo.find({
        where: { profileId, postedAt: MoreThanOrEqual(start) },
        order: { postedAt: 'DESC' },
        take: 500,
      });

      return res.status(200).json({
        isFetchingHistorical: profile.syncState === 'SYNCING',
        profile: {
          name: profile.name,
          platform: profile.platform,
          followers,
          engagementRate: engRate,
        },
        dailySnapshots,
        recentPosts: recentPosts.map((p) => ({
          _id: p.postId,
          postId: p.postId,
          postType: p.postType,
          message: p.message,
          mediaUrl: p.mediaUrl,
          thumbnailUrl: p.thumbnailUrl,
          permalink: p.permalink,
          isPublished: p.isPublished,
          isBoosted: p.isBoosted,
          authorName: p.authorName,
          postedAt: p.postedAt,
          metrics: {
            likes: p.likes,
            comments: p.comments,
            shares: p.shares,
            reach: p.reach,
            views: p.views,
            clicks: p.clicks,
          },
        })),
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }

  /**
   * OPTIMIZED: Added LIMIT to both snapshots and posts queries.
   */
  @Get('debug/:profileId')
  async getDebugData(
    @Param('profileId') profileId: string,
    @Res() res: Response,
  ) {
    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId },
      });

      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      const [snapshotCount, postCount] = await Promise.all([
        this.snapshotRepo.count({ where: { profileId } }),
        this.postRepo.count({ where: { profileId } }),
      ]);

      const [snapshots, posts] = await Promise.all([
        this.snapshotRepo.find({
          where: { profileId },
          order: { date: 'DESC' },
          take: DEBUG_LIMIT,
        }),
        this.postRepo.find({
          where: { profileId },
          order: { postedAt: 'DESC' },
          take: DEBUG_LIMIT,
        }),
      ]);

      return res.status(200).json({
        debug_info: `Raw DB Data for ${profile.name} (${profile.platform})`,
        profile_record: profile,
        total_snapshots_in_db: snapshotCount,
        total_posts_in_db: postCount,
        raw_snapshots: snapshots,
        raw_posts: posts,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * OPTIMIZED: The main reports endpoint.
   * - Snapshots aggregated at DB level with GROUP BY date
   * - Posts aggregated at DB level with GROUP BY date
   * - Previous period aggregated at DB level with SUM
   * - Latest follower counts fetched with a single DISTINCT ON query
   * - No large arrays loaded into Node.js memory
   */
  @Post('aggregate')
  async getAggregatedData(
    @Body()
    body: {
      profileIds: string[];
      days?: number;
      startDate?: string;
      endDate?: string;
    },
    @Res() res: Response,
  ) {
    try {
      const { profileIds, days = 30, startDate, endDate } = body;
      if (!profileIds || profileIds.length === 0)
        return res.status(200).json({ timeSeries: [], totals: null });

      const safeIds = profileIds.slice(0, MAX_PROFILE_IDS);

      let currentEnd: Date;
      let currentStart: Date;

      if (startDate && endDate) {
        currentStart = new Date(startDate);
        currentEnd = new Date(endDate);
        currentEnd.setHours(23, 59, 59, 999);
      } else {
        currentEnd = new Date();
        currentStart = new Date();
        currentStart.setDate(currentStart.getDate() - days);
      }

      const currentStartStr = currentStart.toISOString().split('T')[0];
      const currentEndStr = currentEnd.toISOString().split('T')[0];

      const timeDiff = currentEnd.getTime() - currentStart.getTime();
      const prevStart = new Date(currentStart.getTime() - timeDiff);
      const prevStartStr = prevStart.toISOString().split('T')[0];

      // --- Background sync check (unchanged logic, already lightweight) ---
      const profilesToSync = await this.profileRepo.find({
        where: { profileId: In(safeIds), isActive: true },
        select: ['profileId', 'syncState'],
      });
      const expectedDays =
        Math.floor(
          (currentEnd.getTime() - prevStart.getTime()) / (1000 * 60 * 60 * 24),
        ) + 1;

      for (const profile of profilesToSync) {
        const existingCount = await this.snapshotRepo.count({
          where: {
            profileId: profile.profileId,
            date: Between(prevStartStr, currentEndStr),
          },
        });

        if (existingCount < expectedDays - 2) {
          if (profile.syncState !== 'SYNCING') {
            await this.profileRepo.update(
              { profileId: profile.profileId },
              { syncState: 'SYNCING' },
            );
            await this.syncQueue.add('initial-historical-sync', {
              profileId: profile.profileId,
              daysToFetch: expectedDays,
            });
          }
        }
      }

      // --- CURRENT PERIOD: Snapshot aggregation at DB level (GROUP BY date) ---
      const currentSnapshotAgg: {
        date: string;
        followersGained: string;
        unfollows: string;
        impressions: string;
        engagements: string;
        pageViews: string;
        messages: string;
        videoViews: string;
        revenue: string;
      }[] = await this.snapshotRepo
        .createQueryBuilder('s')
        .select('s.date', 'date')
        .addSelect('COALESCE(SUM(s."followersGained"), 0)', 'followersGained')
        .addSelect('COALESCE(SUM(s.unfollows), 0)', 'unfollows')
        .addSelect(
          'COALESCE(SUM(GREATEST(s."totalImpressions", s."totalReach")), 0)',
          'impressions',
        )
        .addSelect('COALESCE(SUM(s."totalEngagement"), 0)', 'engagements')
        .addSelect('COALESCE(SUM(s."pageViews"), 0)', 'pageViews')
        .addSelect('COALESCE(SUM(s."netMessages"), 0)', 'messages')
        .addSelect(
          `COALESCE(SUM(CASE WHEN s.platform = 'facebook' THEN s."videoViews" ELSE 0 END), 0)`,
          'videoViews',
        )
        .addSelect('COALESCE(SUM(s.revenue), 0)', 'revenue')
        .where('s."profileId" IN (:...ids)', { ids: safeIds })
        .andWhere('s.date >= :start', { start: currentStartStr })
        .andWhere('s.date <= :end', { end: currentEndStr })
        .groupBy('s.date')
        .orderBy('s.date', 'ASC')
        .getRawMany();

      // --- CURRENT PERIOD: Post aggregation at DB level (GROUP BY date) ---
      const currentPostAgg: {
        postDate: string;
        engagements: string;
        fbImpressions: string;
        igImpressions: string;
        igVideoViews: string;
      }[] = await this.postRepo
        .createQueryBuilder('p')
        .select(`TO_CHAR(p."postedAt", 'YYYY-MM-DD')`, 'postDate')
        .addSelect(
          'COALESCE(SUM(p.likes + p.comments + p.shares + p.clicks), 0)',
          'engagements',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'facebook' THEN p.reach ELSE 0 END), 0)`,
          'fbImpressions',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'instagram' THEN p.views + p.reach ELSE 0 END), 0)`,
          'igImpressions',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'instagram' THEN p.views ELSE 0 END), 0)`,
          'igVideoViews',
        )
        .where('p."profileId" IN (:...ids)', { ids: safeIds })
        .andWhere('p."postedAt" >= :start', { start: currentStart })
        .andWhere('p."postedAt" <= :end', { end: currentEnd })
        .groupBy(`TO_CHAR(p."postedAt", 'YYYY-MM-DD')`)
        .getRawMany();

      // Build post-aggregation lookup
      const postAggByDate: Record<
        string,
        {
          engagements: number;
          fbImpressions: number;
          igImpressions: number;
          igVideoViews: number;
        }
      > = {};
      for (const row of currentPostAgg) {
        postAggByDate[row.postDate] = {
          engagements: Number(row.engagements),
          fbImpressions: Number(row.fbImpressions),
          igImpressions: Number(row.igImpressions),
          igVideoViews: Number(row.igVideoViews),
        };
      }

      // Build snapshot-aggregation lookup
      const snapAggByDate: Record<string, (typeof currentSnapshotAgg)[0]> = {};
      for (const row of currentSnapshotAgg) {
        const d =
          typeof row.date === 'string'
            ? row.date.split('T')[0]
            : new Date(row.date).toISOString().split('T')[0];
        snapAggByDate[d] = row;
      }

      // --- Build time series (lightweight: iterate date range, merge pre-aggregated maps) ---
      const timeSeries: any[] = [];
      const dIter = new Date(currentStart);

      while (dIter <= currentEnd) {
        const dStr = dIter.toISOString().split('T')[0];

        const snap = snapAggByDate[dStr];
        const post = postAggByDate[dStr];

        const followersGained = Number(snap?.followersGained || 0);
        const unfollows = Number(snap?.unfollows || 0);
        const snapImpressions = Number(snap?.impressions || 0);
        const snapEngagements = Number(snap?.engagements || 0);
        const snapVideoViews = Number(snap?.videoViews || 0);

        const postEngagements = post?.engagements || 0;
        const postFbImpressions = post?.fbImpressions || 0;
        const postIgImpressions = post?.igImpressions || 0;
        const postIgVideoViews = post?.igVideoViews || 0;

        const totalImpressions =
          snapImpressions + postFbImpressions + postIgImpressions;
        const totalEngagements = snapEngagements + postEngagements;
        const totalVideoViews = snapVideoViews + postIgVideoViews;

        timeSeries.push({
          date: dStr,
          followersGained,
          unfollows,
          netFollowers: followersGained - unfollows,
          totalAudience: 0, // filled below
          impressions: totalImpressions,
          engagements: totalEngagements,
          pageViews: Number(snap?.pageViews || 0),
          messages: Number(snap?.messages || 0),
          videoViews: totalVideoViews,
          engagementRate:
            totalImpressions > 0
              ? Number(
                  ((totalEngagements / totalImpressions) * 100).toFixed(1),
                )
              : 0,
          revenue: Number(snap?.revenue || 0),
        });

        dIter.setDate(dIter.getDate() + 1);
      }

      // --- Audience tracking: get prior follower counts + daily follower snapshots ---
      // Single query: latest snapshot BEFORE current period per profile
      const priorFollowerRows: { profileId: string; totalFollowers: string }[] =
        await this.snapshotRepo
          .createQueryBuilder('s')
          .select('s."profileId"', 'profileId')
          .addSelect('s."totalFollowers"', 'totalFollowers')
          .where(
            `s.id IN (
              SELECT DISTINCT ON (sub."profileId") sub.id
              FROM analytics_snapshots sub
              WHERE sub."profileId" IN (:...ids) AND sub.date < :start
              ORDER BY sub."profileId", sub.date DESC
            )`,
            { ids: safeIds, start: currentStartStr },
          )
          .getRawMany();

      const latestFollowers: Record<string, number> = {};
      for (const pid of safeIds) {
        latestFollowers[pid] = 0;
      }
      for (const row of priorFollowerRows) {
        const val = Number(row.totalFollowers);
        if (val > 0) latestFollowers[row.profileId] = val;
      }

      // Get daily totalFollowers per profile within current period (for running audience)
      const dailyFollowerRows: {
        date: string;
        profileId: string;
        totalFollowers: string;
      }[] = await this.snapshotRepo
        .createQueryBuilder('s')
        .select('s.date', 'date')
        .addSelect('s."profileId"', 'profileId')
        .addSelect('s."totalFollowers"', 'totalFollowers')
        .where('s."profileId" IN (:...ids)', { ids: safeIds })
        .andWhere('s.date >= :start', { start: currentStartStr })
        .andWhere('s.date <= :end', { end: currentEndStr })
        .andWhere('s."totalFollowers" > 0')
        .orderBy('s.date', 'ASC')
        .getRawMany();

      // Build a map: date -> { profileId -> totalFollowers }
      const dailyFollowerMap: Record<string, Record<string, number>> = {};
      for (const row of dailyFollowerRows) {
        const d =
          typeof row.date === 'string'
            ? row.date.split('T')[0]
            : new Date(row.date).toISOString().split('T')[0];
        if (!dailyFollowerMap[d]) dailyFollowerMap[d] = {};
        dailyFollowerMap[d][row.profileId] = Number(row.totalFollowers);
      }

      // Walk through timeSeries and compute running audience
      for (const day of timeSeries) {
        const dayFollowers = dailyFollowerMap[day.date];
        if (dayFollowers) {
          for (const [pid, val] of Object.entries(dayFollowers)) {
            latestFollowers[pid] = val;
          }
        }

        let dailyAudience = 0;
        for (const pid of safeIds) {
          dailyAudience += latestFollowers[pid] || 0;
        }
        day.totalAudience = dailyAudience;
      }

      // --- Current audience: single query with DISTINCT ON ---
      const absoluteLatestRows: {
        profileId: string;
        totalFollowers: string;
      }[] = await this.snapshotRepo
        .createQueryBuilder('s')
        .select('s."profileId"', 'profileId')
        .addSelect('s."totalFollowers"', 'totalFollowers')
        .where(
          `s.id IN (
            SELECT DISTINCT ON (sub."profileId") sub.id
            FROM analytics_snapshots sub
            WHERE sub."profileId" IN (:...ids) AND sub."totalFollowers" > 0
            ORDER BY sub."profileId", sub.date DESC
          )`,
          { ids: safeIds },
        )
        .getRawMany();

      let currentAudience = 0;
      for (const row of absoluteLatestRows) {
        currentAudience += Number(row.totalFollowers);
      }

      // --- PREVIOUS PERIOD: aggregate at DB level ---
      const prevSnapAgg: {
        netGrowth: string;
        engagements: string;
        impressions: string;
        fbVideoViews: string;
        pageViews: string;
        messages: string;
        revenue: string;
      } | undefined = await this.snapshotRepo
        .createQueryBuilder('s')
        .select(
          'COALESCE(SUM(s."followersGained"), 0) - COALESCE(SUM(s.unfollows), 0)',
          'netGrowth',
        )
        .addSelect('COALESCE(SUM(s."totalEngagement"), 0)', 'engagements')
        .addSelect(
          `COALESCE(SUM(GREATEST(s."totalImpressions", s."totalReach")), 0) + COALESCE(SUM(CASE WHEN s.platform = 'facebook' THEN s."videoViews" ELSE 0 END), 0)`,
          'impressions',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN s.platform = 'facebook' THEN s."videoViews" ELSE 0 END), 0)`,
          'fbVideoViews',
        )
        .addSelect('COALESCE(SUM(s."pageViews"), 0)', 'pageViews')
        .addSelect('COALESCE(SUM(s."netMessages"), 0)', 'messages')
        .addSelect('COALESCE(SUM(s.revenue), 0)', 'revenue')
        .where('s."profileId" IN (:...ids)', { ids: safeIds })
        .andWhere('s.date >= :start', { start: prevStartStr })
        .andWhere('s.date < :end', { end: currentStartStr })
        .getRawOne();

      const prevPostAgg: {
        engagements: string;
        fbImpressions: string;
        igImpressions: string;
        igVideoViews: string;
      } | undefined = await this.postRepo
        .createQueryBuilder('p')
        .select(
          'COALESCE(SUM(p.likes + p.comments + p.shares + p.clicks), 0)',
          'engagements',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'facebook' THEN p.reach ELSE 0 END), 0)`,
          'fbImpressions',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'instagram' THEN p.views + p.reach ELSE 0 END), 0)`,
          'igImpressions',
        )
        .addSelect(
          `COALESCE(SUM(CASE WHEN p.platform = 'instagram' THEN p.views ELSE 0 END), 0)`,
          'igVideoViews',
        )
        .where('p."profileId" IN (:...ids)', { ids: safeIds })
        .andWhere('p."postedAt" >= :start', { start: prevStart })
        .andWhere('p."postedAt" < :end', { end: currentStart })
        .getRawOne();

      // --- Compute current totals from timeSeries (already in memory, tiny array) ---
      let currentNetGrowth = 0;
      let currentImpressions = 0;
      let currentVideoViews = 0;
      let currentEngagements = 0;
      let currentPageViews = 0;
      let currentMessages = 0;
      let currentRevenue = 0;

      for (const s of timeSeries) {
        currentNetGrowth += s.netFollowers;
        currentImpressions += s.impressions;
        currentVideoViews += s.videoViews;
        currentEngagements += s.engagements;
        currentPageViews += s.pageViews;
        currentMessages += s.messages;
        currentRevenue += s.revenue;
      }

      const currentEngRate =
        currentImpressions > 0
          ? (currentEngagements / currentImpressions) * 100
          : 0;

      // Previous period totals
      const prevNetGrowth = Number(prevSnapAgg?.netGrowth || 0);
      const prevAudience = currentAudience - currentNetGrowth;
      const prevEngagements =
        Number(prevSnapAgg?.engagements || 0) +
        Number(prevPostAgg?.engagements || 0);
      const prevImpressions =
        Number(prevSnapAgg?.impressions || 0) +
        Number(prevPostAgg?.fbImpressions || 0) +
        Number(prevPostAgg?.igImpressions || 0);
      const prevVideoViews =
        Number(prevSnapAgg?.fbVideoViews || 0) +
        Number(prevPostAgg?.igVideoViews || 0);
      const prevPageViews = Number(prevSnapAgg?.pageViews || 0);
      const prevMessages = Number(prevSnapAgg?.messages || 0);
      const prevRevenue = Number(prevSnapAgg?.revenue || 0);
      const prevEngRate =
        prevImpressions > 0 ? (prevEngagements / prevImpressions) * 100 : 0;

      const calcChange = (current: number, previous: number) => {
        if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
        return ((current - previous) / Math.abs(previous)) * 100;
      };

      return res.status(200).json({
        timeSeries,
        totals: {
          currentAudience,
          audienceChange: calcChange(currentAudience, prevAudience).toFixed(1),
          netGrowth: currentNetGrowth,
          growthChange: calcChange(currentNetGrowth, prevNetGrowth).toFixed(1),
          impressions: currentImpressions,
          impressionsChange: calcChange(
            currentImpressions,
            prevImpressions,
          ).toFixed(1),
          engagements: currentEngagements,
          engagementsChange: calcChange(
            currentEngagements,
            prevEngagements,
          ).toFixed(1),
          engagementRate: currentEngRate.toFixed(1),
          engagementRateChange: calcChange(currentEngRate, prevEngRate).toFixed(
            1,
          ),
          pageViews: currentPageViews,
          pageViewsChange: calcChange(currentPageViews, prevPageViews).toFixed(
            1,
          ),
          videoViews: currentVideoViews,
          videoViewsChange: calcChange(
            currentVideoViews,
            prevVideoViews,
          ).toFixed(1),
          messages: currentMessages,
          messagesChange: calcChange(currentMessages, prevMessages).toFixed(1),
          revenue: currentRevenue,
          revenueChange: calcChange(currentRevenue, prevRevenue).toFixed(1),
        },
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  @Post('posts')
  async getPosts(
    @Body()
    body: { profileIds: string[]; startDate?: string; endDate?: string },
    @Res() res: Response,
  ) {
    try {
      const { profileIds, startDate, endDate } = body;
      if (!profileIds || profileIds.length === 0)
        return res.status(200).json([]);

      const safeIds = profileIds.slice(0, MAX_PROFILE_IDS);

      let start: Date;
      let end: Date;

      if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
      } else {
        end = new Date();
        start = new Date();
        start.setDate(start.getDate() - 30);
      }

      const posts = await this.postRepo.find({
        where: {
          profileId: In(safeIds),
          postedAt: Between(start, end),
        },
        order: {
          postedAt: 'DESC',
        },
        take: 1000,
      });

      return res.status(200).json(posts);
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  @Post('profiles/:profileId/sync')
  async triggerManualSync(
    @Param('profileId') profileId: string,
    @Body() body: { days?: number },
    @Res() res: Response,
  ) {
    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId, isActive: true },
      });
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      let daysToFetch = body.days;

      if (!daysToFetch) {
        const latestSnapshot = await this.snapshotRepo.findOne({
          where: { profileId },
          order: { date: 'DESC' },
          select: ['date'],
        });

        if (latestSnapshot) {
          const lastDate = new Date(latestSnapshot.date);
          const today = new Date();
          const diffTime = Math.abs(today.getTime() - lastDate.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          daysToFetch = diffDays > 0 ? diffDays + 2 : 2;
        } else {
          daysToFetch = 90;
        }
      }

      daysToFetch = Math.min(daysToFetch, 90);

      await this.profileRepo.update(
        { profileId },
        { syncState: 'SYNCING', lastSyncError: '' },
      );

      await this.syncQueue.add('initial-historical-sync', {
        profileId,
        daysToFetch,
      });

      return res.status(200).json({
        success: true,
        message: `Manual sync queued for ${daysToFetch} days`,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}
