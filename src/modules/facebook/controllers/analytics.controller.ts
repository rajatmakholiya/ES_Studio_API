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

      const aggregated = {
        genderAge: {} as Record<string, number>,
        topCities: {} as Record<string, number>,
        topCountries: {} as Record<string, number>,
      };

      for (const pid of profileIds) {
        const demo = await this.demographicRepo.findOne({
          where: { profileId: pid },
          order: { date: 'DESC' },
        });

        if (!demo) continue;

        // Aggregate gender/age
        if (demo.genderAge) {
          for (const [key, val] of Object.entries(demo.genderAge)) {
            aggregated.genderAge[key] =
              (aggregated.genderAge[key] || 0) + Number(val);
          }
        }
        // Aggregate cities
        if (demo.topCities) {
          for (const [key, val] of Object.entries(demo.topCities)) {
            aggregated.topCities[key] =
              (aggregated.topCities[key] || 0) + Number(val);
          }
        }
        // Aggregate countries
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

  @Get(':profileId/data')
  async getSmartAnalytics(
    @Param('profileId') profileId: string,
    @Query('days') daysStr: string,
    @Res() res: Response,
  ) {
    try {
      const days = parseInt(daysStr) || 30;
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days);
      const startStr = start.toISOString().split('T')[0];

      const profile = await this.profileRepo.findOne({ where: { profileId } });
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      const dailySnapshots = await this.snapshotRepo.find({
        where: { profileId, date: MoreThanOrEqual(startStr) },
        order: { date: 'ASC' },
      });

      const recentPosts = await this.postRepo.find({
        where: { profileId, postedAt: MoreThanOrEqual(start) },
        order: { postedAt: 'DESC' },
      });

      const totalEngagements = recentPosts.reduce(
        (sum, p) =>
          sum +
          Number(p.likes) +
          Number(p.comments) +
          Number(p.shares) +
          Number(p.clicks),
        0,
      );

      const absoluteLatestSnap = await this.snapshotRepo.findOne({
        where: { profileId },
        order: { date: 'DESC' },
      });
      const followers = absoluteLatestSnap
        ? absoluteLatestSnap.totalFollowers
        : 0;

      const engRate =
        followers > 0
          ? ((totalEngagements / followers) * 100).toFixed(2) + '%'
          : '0.00%';

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

      const snapshots = await this.snapshotRepo.find({
        where: { profileId },
        order: { date: 'DESC' },
      });

      const posts = await this.postRepo.find({
        where: { profileId },
        order: { postedAt: 'DESC' },
      });

      return res.status(200).json({
        debug_info: `Raw DB Data for ${profile.name} (${profile.platform})`,
        profile_record: profile,
        total_snapshots_in_db: snapshots.length,
        total_posts_in_db: posts.length,
        raw_snapshots: snapshots,
        raw_posts: posts,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

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

      const profilesToSync = await this.profileRepo.find({
        where: { profileId: In(profileIds), isActive: true },
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
          // Instead of a heavy blocking sync inline, offload to background
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

      // FETCH DATA FROM DATABASE
      const snapshots = await this.snapshotRepo.find({
        where: {
          profileId: In(profileIds),
          date: Between(prevStartStr, currentEndStr),
        },
        order: { date: 'ASC' },
      });

      const normalizeDate = (d: any) => {
        if (!d) return '';
        if (typeof d === 'string') return d.split('T')[0];
        return new Date(d).toISOString().split('T')[0];
      };

      const currentSnapshots = snapshots.filter((s) => {
        const d = normalizeDate(s.date);
        return d >= currentStartStr && d <= currentEndStr;
      });

      const prevSnapshots = snapshots.filter((s) => {
        const d = normalizeDate(s.date);
        return d >= prevStartStr && d < currentStartStr;
      });

      const currentPosts = await this.postRepo.find({
        where: {
          profileId: In(profileIds),
          postedAt: Between(currentStart, currentEnd),
        },
      });
      const prevPosts = await this.postRepo.find({
        where: {
          profileId: In(profileIds),
          postedAt: Between(prevStart, currentStart),
        },
      });

      const timeSeriesMap: Record<string, any> = {};
      let dIter = new Date(currentStart);

      while (dIter <= currentEnd) {
        const dStr = dIter.toISOString().split('T')[0];
        timeSeriesMap[dStr] = {
          date: dStr,
          followersGained: 0,
          unfollows: 0,
          netFollowers: 0,
          totalAudience: 0,
          impressions: 0,
          engagements: 0,
          pageViews: 0,
          messages: 0,
          videoViews: 0,
          engagementRate: 0,
          revenue: 0,
        };
        dIter.setDate(dIter.getDate() + 1);
      }

      currentSnapshots.forEach((snap) => {
        const d = normalizeDate(snap.date);
        if (timeSeriesMap[d]) {
          timeSeriesMap[d].followersGained += Number(snap.followersGained || 0);
          timeSeriesMap[d].unfollows += Number(snap.unfollows || 0);
          timeSeriesMap[d].netFollowers +=
            Number(snap.followersGained || 0) - Number(snap.unfollows || 0);
          timeSeriesMap[d].impressions += Number(
            snap.totalImpressions || snap.totalReach || 0,
          );
          timeSeriesMap[d].engagements += Number(snap.totalEngagement || 0);
          timeSeriesMap[d].pageViews += Number(snap.pageViews || 0);
          timeSeriesMap[d].messages += Number(snap.netMessages || 0);
          timeSeriesMap[d].revenue += Number(snap.revenue || 0);

          if (snap.platform === 'facebook') {
            timeSeriesMap[d].videoViews += Number(snap.videoViews || 0);
          }
        }
      });

      currentPosts.forEach((post) => {
        const postDateStr = new Date(post.postedAt).toISOString().split('T')[0];
        if (timeSeriesMap[postDateStr]) {
          const postEngagements =
            Number(post.likes || 0) +
            Number(post.comments || 0) +
            Number(post.shares || 0) +
            Number(post.clicks || 0);
          timeSeriesMap[postDateStr].engagements += postEngagements;

          if (post.platform === 'instagram') {
            timeSeriesMap[postDateStr].videoViews += Number(post.views || 0);
            timeSeriesMap[postDateStr].impressions +=
              Number(post.views || 0) + Number(post.reach || 0);
          } else if (post.platform === 'facebook') {
            timeSeriesMap[postDateStr].impressions += Number(post.reach || 0);
          }
        }
      });

      const timeSeries = Object.values(timeSeriesMap).sort(
        (a: any, b: any) =>
          new Date(a.date).getTime() - new Date(b.date).getTime(),
      );

      const latestFollowers: Record<string, number> = {};
      for (const pid of profileIds) {
        const priorSnap = await this.snapshotRepo.findOne({
          where: { profileId: pid, date: LessThan(currentStartStr) },
          order: { date: 'DESC' },
        });
        latestFollowers[pid] =
          priorSnap && priorSnap.totalFollowers > 0
            ? priorSnap.totalFollowers
            : 0;
      }

      timeSeries.forEach((day) => {
        const daySnaps = currentSnapshots.filter(
          (s) => normalizeDate(s.date) === day.date,
        );
        daySnaps.forEach((s) => {
          if (s.totalFollowers > 0)
            latestFollowers[s.profileId] = s.totalFollowers;
        });

        let dailyAudience = 0;
        profileIds.forEach((pid) => {
          dailyAudience += latestFollowers[pid] || 0;
        });
        day.totalAudience = dailyAudience;

        day.engagementRate =
          day.impressions > 0
            ? Number(((day.engagements / day.impressions) * 100).toFixed(1))
            : 0;
      });

      let currentAudience = 0;
      for (const pid of profileIds) {
        const absoluteLatest = await this.snapshotRepo.findOne({
          where: { profileId: pid },
          order: { date: 'DESC' },
        });
        if (absoluteLatest && absoluteLatest.totalFollowers > 0) {
          currentAudience += absoluteLatest.totalFollowers;
        }
      }

      const currentNetGrowth = timeSeries.reduce(
        (sum, s) => sum + Number(s.netFollowers || 0),
        0,
      );
      const currentImpressions = timeSeries.reduce(
        (sum, s) => sum + Number(s.impressions || 0),
        0,
      );
      const currentVideoViews = timeSeries.reduce(
        (sum, s) => sum + Number(s.videoViews || 0),
        0,
      );
      const currentEngagements = timeSeries.reduce(
        (sum, s) => sum + Number(s.engagements || 0),
        0,
      );
      const currentPageViews = timeSeries.reduce(
        (sum, s) => sum + Number(s.pageViews || 0),
        0,
      );
      const currentMessages = timeSeries.reduce(
        (sum, s) => sum + Number(s.messages || 0),
        0,
      );
      const currentRevenue = timeSeries.reduce(
        (sum, s) => sum + Number(s.revenue || 0),
        0,
      );

      const currentEngRate =
        currentImpressions > 0
          ? (currentEngagements / currentImpressions) * 100
          : 0;

      const prevNetGrowth = prevSnapshots.reduce(
        (sum, s) =>
          sum + (Number(s.followersGained) || 0) - (Number(s.unfollows) || 0),
        0,
      );
      const prevAudience = currentAudience - currentNetGrowth;

      let prevEngagements = prevSnapshots.reduce(
        (sum, s) => sum + (Number(s.totalEngagement) || 0),
        0,
      );
      let prevImpressions = prevSnapshots.reduce(
        (sum, s) =>
          sum +
          (Number(s.totalImpressions) || Number(s.totalReach) || 0) +
          (s.platform === 'facebook' ? Number(s.videoViews) || 0 : 0),
        0,
      );
      let prevVideoViews = prevSnapshots
        .filter((s) => s.platform === 'facebook')
        .reduce((sum, s) => sum + (Number(s.videoViews) || 0), 0);

      prevPosts.forEach((p) => {
        prevEngagements +=
          Number(p.likes || 0) +
          Number(p.comments || 0) +
          Number(p.shares || 0) +
          Number(p.clicks || 0);
        if (p.platform === 'instagram') {
          prevVideoViews += Number(p.views || 0);
          prevImpressions += Number(p.views || 0) + Number(p.reach || 0);
        } else if (p.platform === 'facebook') {
          prevImpressions += Number(p.reach || 0);
        }
      });

      const prevPageViews = prevSnapshots.reduce(
        (sum, s) => sum + (Number(s.pageViews) || 0),
        0,
      );
      const prevMessages = prevSnapshots.reduce(
        (sum, s) => sum + (Number(s.netMessages) || 0),
        0,
      );
      const prevRevenue = prevSnapshots.reduce(
        (sum, s) => sum + (Number(s.revenue) || 0),
        0,
      );
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
          profileId: In(profileIds),
          postedAt: Between(start, end),
        },
        order: {
          postedAt: 'DESC',
        },
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
