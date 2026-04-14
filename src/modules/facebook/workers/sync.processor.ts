import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { DemographicSnapshot } from '../entities/DemographicSnapshot.entity';
import { DailyRevenue } from '../../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../../revenue/entities/revenue-mapping.entity';
import {
  fetchProfileBasics,
  fetchDailySnapshot,
  fetchPostsPaginated,
  fetchPostDeepInsights,
  fetchDemographics,
  fetchDailyRevenue,
  fetchSegregatedRevenue,
} from '../services/meta.service';

@Processor('social-sync-queue')
export class SyncProcessor {
  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(SocialPost)
    private postRepo: Repository<SocialPost>,
    @InjectRepository(DemographicSnapshot)
    private demographicRepo: Repository<DemographicSnapshot>,
    @InjectRepository(DailyRevenue)
    private dailyRevenueRepo: Repository<DailyRevenue>,
    @InjectRepository(RevenueMapping)
    private revenueMappingRepo: Repository<RevenueMapping>,
  ) {}

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  @Process('initial-historical-sync')
  async handleHistoricalSync(job: Job) {
    const { profileId, daysToFetch = 85 } = job.data;

    try {
      const profile = await this.profileRepo.findOne({
        where: { profileId, isActive: true },
      });

      if (!profile) return;

      console.log(
        `\n[Worker] Starting historical ${daysToFetch}-day sync for profile ${profile.profileId}`,
      );

      await this.profileRepo.update(
        { profileId },
        { syncState: 'SYNCING', lastSyncError: '' },
      );

      const basics = await fetchProfileBasics(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
      );

      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - daysToFetch);

      const chunks: any[] = [];
      let currentStart = new Date(start);

      while (currentStart < end) {
        let currentEnd = new Date(currentStart);
        currentEnd.setDate(currentEnd.getDate() + 29);
        if (currentEnd > end) currentEnd = new Date(end);

        chunks.push({
          start: new Date(currentStart),
          end: new Date(currentEnd),
        });

        currentStart = new Date(currentEnd);
        currentStart.setDate(currentStart.getDate() + 1);
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        console.log(
          `[Worker] Processing chunk ${i + 1}/${chunks.length} (${chunk.start.toISOString().split('T')[0]} to ${chunk.end.toISOString().split('T')[0]})...`,
        );

        let sinceUnix = Math.floor(chunk.start.getTime() / 1000);
        let untilUnix = Math.floor(chunk.end.getTime() / 1000);

        const dailyRaw = await fetchDailySnapshot(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
          sinceUnix,
          untilUnix,
        );

        const dailyDataMap: Record<string, any> = {};

        if (Array.isArray(dailyRaw)) {
          dailyRaw.forEach((metric: any) => {
            if (metric.values) {
              metric.values.forEach((val: any) => {
                const actualDate = new Date(val.end_time);
                actualDate.setDate(actualDate.getDate() - 1);
                const dateStr = actualDate.toISOString().split('T')[0];
                if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
                dailyDataMap[dateStr][metric.name] = val.value;
              });
            } else if (metric.total_value) {
              const dateStr = chunk.start.toISOString().split('T')[0];
              if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
              dailyDataMap[dateStr][metric.name] = metric.total_value.value;
            }
          });
        }

        const snapshotPayloads: any[] = [];
        let fillDate = new Date(chunk.start);

        while (fillDate <= chunk.end) {
          const dateStr = fillDate.toISOString().split('T')[0];
          const metrics = dailyDataMap[dateStr] || {};

          let igGained = 0;
          let igUnfollows = 0;
          if (
            profile.platform === 'instagram' &&
            metrics['follower_count'] !== undefined
          ) {
            const net = Number(metrics['follower_count']);
            if (net > 0) igGained = net;
            if (net < 0) igUnfollows = Math.abs(net);
          }

          snapshotPayloads.push({
            profileId: profile.profileId,
            date: dateStr,
            platform: profile.platform,
            totalFollowers: basics?.followers_count || 0,

            followersGained:
              profile.platform === 'facebook'
                ? metrics['page_daily_follows_unique'] || 0
                : igGained,
            unfollows:
              profile.platform === 'facebook'
                ? metrics['page_daily_unfollows_unique'] || 0
                : igUnfollows,

            totalReach:
              profile.platform === 'facebook'
                ? metrics['page_impressions_unique'] || 0
                : metrics['reach'] || 0,
            totalImpressions:
              profile.platform === 'facebook'
                ? metrics['page_impressions_unique'] || 0
                : metrics['views'] || metrics['reach'] || 0,
            videoViews:
              profile.platform === 'facebook'
                ? metrics['page_video_views'] || 0
                : 0,
            totalEngagement:
              profile.platform === 'facebook'
                ? metrics['page_post_engagements'] || 0
                : metrics['total_interactions'] || 0,
            profileClicks:
              profile.platform === 'facebook'
                ? metrics['page_total_actions'] || 0
                : metrics['website_clicks'] || 0,
            pageViews:
              profile.platform === 'facebook'
                ? metrics['page_views_total'] || 0
                : metrics['profile_views'] || 0,
            netMessages:
              profile.platform === 'facebook'
                ? (metrics['page_messages_new_conversations_unique'] || 0) +
                  (metrics['page_messages_total_messaging_connections'] || 0)
                : 0,
          });

          fillDate.setDate(fillDate.getDate() + 1);
        }

        if (snapshotPayloads.length > 0) {
          await this.snapshotRepo.upsert(snapshotPayloads, [
            'profileId',
            'date',
          ]);
        }
        if (i < chunks.length - 1) await this.sleep(2000);
      }

      console.log(`[Worker] Found ${chunks.length} chunks. Fetching Posts...`);

      const recentPosts = await fetchPostsPaginated(
        profile.profileId,
        profile.accessToken,
        profile.platform as any,
        start,
        end,
      );

      const postPayloads: any[] = [];
      for (const post of recentPosts) {
        const rawType = (
          post.status_type ||
          post.media_type ||
          post.media_product_type ||
          'UNKNOWN'
        ).toLowerCase();
        let normalizedType = 'text';

        if (rawType.includes('video') || rawType.includes('reel')) {
          normalizedType = 'video';
        } else if (
          rawType.includes('photo') ||
          rawType.includes('image') ||
          rawType.includes('carousel') ||
          rawType.includes('album')
        ) {
          normalizedType = 'photo';
        }

        let views = 0,
          reach = 0,
          clicks = 0,
          shares = 0;

        try {
          const deep = await fetchPostDeepInsights(
            post.id,
            profile.accessToken,
            profile.platform as any,
            rawType,
          );
          const getInsight = (arr: any[], name: string) =>
            arr?.find((i: any) => i.name === name)?.values[0]?.value || 0;

          if (profile.platform === 'facebook') {
            clicks = getInsight(deep, 'post_clicks');
            reach = getInsight(deep, 'post_impressions_unique');
            views = getInsight(deep, 'post_video_views');
            shares = post.shares?.count || post.shares_count || 0;
          } else {
            reach = getInsight(deep, 'reach');
            views = getInsight(deep, 'views');
            shares = getInsight(deep, 'shares') || 0;
            clicks = getInsight(deep, 'saved') || 0;
          }
          await this.sleep(200);
        } catch (e) {}

        postPayloads.push({
          profileId: profile.profileId,
          postId: post.id,
          platform: profile.platform,
          postType: normalizedType,
          message: post.message || post.caption || '',
          mediaUrl:
            post.media_url || post.attachments?.data?.[0]?.media?.source || '',
          thumbnailUrl:
            post.full_picture ||
            post.picture ||
            post.thumbnail_url ||
            post.media_url ||
            post.attachments?.data?.[0]?.media?.image?.src ||
            '',
          permalink: post.permalink_url || post.permalink || '',
          isPublished:
            post.is_published !== undefined ? post.is_published : true,
          isBoosted: post.is_eligible_for_promotion === false,
          authorName: post.from?.name || post.owner?.username || 'Unknown',
          postedAt: new Date(post.created_time || post.timestamp),
          likes: post.likes?.summary?.total_count || post.like_count || 0,
          comments:
            post.comments?.summary?.total_count || post.comments_count || 0,
          shares,
          reach,
          views,
          clicks,
        });
      }

      if (postPayloads.length > 0) {
        await this.postRepo.upsert(postPayloads, ['postId']);
      }

      // --- DEMOGRAPHICS: Fetch lifetime audience data ---
      console.log(`[Worker] Fetching demographics for ${profileId}...`);
      try {
        const demographics = await fetchDemographics(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
        );

        const today = new Date().toISOString().split('T')[0];
        await this.demographicRepo.upsert(
          {
            profileId: profile.profileId,
            date: today,
            platform: profile.platform,
            genderAge: demographics.genderAge,
            topCities: demographics.topCities,
            topCountries: demographics.topCountries,
          },
          ['profileId', 'date'],
        );
        console.log(`[Worker] Demographics saved for ${profileId}.`);
      } catch (demoErr: any) {
        console.warn(
          `[Worker] Demographics fetch skipped for ${profileId}:`,
          demoErr.message,
        );
      }

      // --- REVENUE: Fetch segregated daily revenue for Facebook pages only ---
      if (profile.platform === 'facebook') {
        console.log(`[Worker] Fetching segregated revenue data for ${profileId}...`);
        try {
          const sinceUnix = Math.floor(start.getTime() / 1000);
          const untilUnix = Math.floor(end.getTime() / 1000);

          // Ensure this page has a RevenueMapping entry
          const existingMapping = await this.revenueMappingRepo.findOne({
            where: { pageId: profile.profileId },
          });
          if (!existingMapping) {
            await this.revenueMappingRepo.save({
              pageId: profile.profileId,
              pageName: basics?.name || profile.name || profile.profileId,
              team: 'Unassigned',
            });
            console.log(
              `[Worker] Auto-created revenue mapping for page "${basics?.name || profile.profileId}"`,
            );
          } else if (basics?.name && existingMapping.pageName !== basics.name) {
            // Keep page name in sync
            await this.revenueMappingRepo.update(existingMapping.id, {
              pageName: basics.name,
            });
          }

          // Fetch segregated revenue (bonus, photo, reel, story, text)
          const segregated = await fetchSegregatedRevenue(
            profile.profileId,
            profile.accessToken,
            sinceUnix,
            untilUnix,
          );

          if (segregated.length > 0) {
            // Upsert into daily_revenue table
            const payloads = segregated.map((day) => ({
              pageId: profile.profileId,
              date: day.date,
              bonusRevenue: day.bonus,
              photoRevenue: day.photo,
              reelRevenue: day.reel,
              storyRevenue: day.story,
              textRevenue: day.text,
              totalRevenue: day.total,
            }));

            await this.dailyRevenueRepo.upsert(payloads, ['pageId', 'date']);

            // Keep analytics_snapshots.revenue in sync (Reports page reads this).
            // Always write — even when total is 0 — so stale/incorrect values
            // from previous syncs get corrected.
            for (const day of segregated) {
              await this.snapshotRepo.update(
                { profileId: profile.profileId, date: day.date },
                { revenue: day.total },
              );
            }

            console.log(
              `[Worker] Segregated revenue saved for ${profileId} (${segregated.length} days).`,
            );
          }
        } catch (revErr: any) {
          console.warn(
            `[Worker] Revenue fetch skipped for ${profileId}:`,
            revErr.message,
          );
        }
      }

      await this.profileRepo.update(
        { profileId },
        { syncState: 'COMPLETED', lastSyncError: undefined },
      );
      console.log(
        `[Worker] Successfully finished sync for ${job.data.profileId}.\n`,
      );
    } catch (error: any) {
      await this.profileRepo.update(
        { profileId },
        {
          syncState: 'FAILED',
          lastSyncError: error.message || 'Worker sync failed',
        },
      );
    }
  }
}
