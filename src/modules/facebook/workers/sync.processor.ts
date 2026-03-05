import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import {
  fetchPostsPaginated,
  fetchDailySnapshot,
  fetchProfileBasics,
  fetchPostDeepInsights,
} from '../services/meta.service';

@Processor('social-sync-queue')
export class SyncProcessor {
  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(SocialPost) private postRepo: Repository<SocialPost>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
  ) {}

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  @Process('initial-historical-sync')
  async handleInitialSync(
    job: Job<{ profileId: string; daysToFetch?: number }>,
  ) {
    const totalDays = job.data.daysToFetch || 90;
    console.log(
      `\n[Worker] Starting historical ${totalDays}-day sync for profile ${job.data.profileId}`,
    );

    const profile = await this.profileRepo.findOne({
      where: { profileId: job.data.profileId },
    });
    if (!profile) return;

    await this.profileRepo.update(
      { profileId: profile.profileId },
      { syncState: 'SYNCING', lastSyncError: '' },
    );

    const basics = await fetchProfileBasics(
      profile.profileId,
      profile.accessToken,
      profile.platform as any,
    );
    const chunkSize = 30;
    const chunks = Math.ceil(totalDays / chunkSize);

    try {
      for (let i = 0; i < chunks; i++) {
        const untilDate = new Date();
        untilDate.setDate(untilDate.getDate() - i * chunkSize);

        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - (i + 1) * chunkSize);

        const sinceUnix = Math.floor(sinceDate.getTime() / 1000);
        const untilUnix = Math.floor(untilDate.getTime() / 1000);

        console.log(
          `[Worker] Processing chunk ${i + 1}/${chunks} (${sinceDate.toISOString().split('T')[0]} to ${untilDate.toISOString().split('T')[0]})...`,
        );

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
            metric.values?.forEach((val: any) => {
              const actualDate = new Date(val.end_time);
              actualDate.setDate(actualDate.getDate() - 1);
              const dateStr = actualDate.toISOString().split('T')[0];
              if (!dailyDataMap[dateStr]) dailyDataMap[dateStr] = {};
              dailyDataMap[dateStr][metric.name] = val.value;
            });
          });
        }

        const snapshotPayloads: any[] = [];
        let fillDate = new Date(sinceDate);

        while (fillDate <= untilDate) {
          const dateStr = fillDate.toISOString().split('T')[0];
          const metrics = dailyDataMap[dateStr] || {};

          snapshotPayloads.push({
            profileId: profile.profileId,
            date: dateStr,
            platform: profile.platform,
            totalFollowers: basics?.followers_count || 0,
            followersGained:
              profile.platform === 'facebook'
                ? metrics['page_daily_follows_unique'] || 0
                : metrics['follower_count'] || 0,
            unfollows:
              profile.platform === 'facebook'
                ? metrics['page_daily_unfollows_unique'] || 0
                : 0,

            totalReach:
              profile.platform === 'facebook'
                ? metrics['page_impressions_unique'] || 0
                : metrics['reach'] || 0,

            totalImpressions:
              profile.platform === 'facebook'
                ? metrics['page_impressions_unique'] || 0
                : metrics['impressions'] || 0,

            videoViews:
              profile.platform === 'facebook'
                ? metrics['page_video_views'] || 0
                : 0,
            totalEngagement:
              profile.platform === 'facebook'
                ? metrics['page_post_engagements'] || 0
                : 0,

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

        const posts = await fetchPostsPaginated(
          profile.profileId,
          profile.accessToken,
          profile.platform as any,
          sinceDate,
          untilDate,
        );
        console.log(
          `[Worker] Found ${posts.length} posts. Fetching deep insights & engagement individually...`,
        );
        const postPayloads: any[] = [];

        for (const post of posts) {
          let type = post.status_type || post.media_product_type || 'UNKNOWN';

          if (post.is_story) {
            type = 'story';
          } else if (profile.platform === 'facebook') {
            const attType = post.attachments?.data?.[0]?.type;
            if (!attType) type = 'text';
            else if (attType === 'share' || attType === 'animated_image_share')
              type = 'link';
            else if (attType.includes('video')) type = 'video';
            else if (attType.includes('photo') || attType === 'album')
              type = 'photo';
          } else {
            if (post.media_type) type = post.media_type.toLowerCase();
          }

          let views = 0,
            reach = 0,
            clicks = 0;
          let likes = 0,
            comments = 0,
            shares = 0;

          try {
            const deep = await fetchPostDeepInsights(
              post.id,
              profile.accessToken,
              profile.platform as any,
              type,
            );
            const getInsight = (arr: any[], name: string) =>
              arr?.find((i: any) => i.name === name)?.values[0]?.value || 0;

            if (type === 'story') {
              if (profile.platform === 'instagram') {
                reach = getInsight(deep, 'reach');
                views = getInsight(deep, 'impressions');
                comments = getInsight(deep, 'replies');
              } else {
                reach = getInsight(deep, 'post_impressions_unique');
              }
            } else {
              clicks = getInsight(deep, 'post_clicks');
              reach = getInsight(
                deep,
                profile.platform === 'facebook'
                  ? 'post_impressions_unique'
                  : 'reach',
              );
              views = getInsight(
                deep,
                profile.platform === 'facebook' ? 'post_video_views' : 'plays',
              );
            }

            if (profile.platform === 'facebook' && type !== 'story') {
              const engUrl = `https://graph.facebook.com/v18.0/${post.id}?fields=shares,likes.summary(true),comments.summary(true)&access_token=${profile.accessToken}`;
              const engRes = await axios.get(engUrl);
              likes = engRes.data.likes?.summary?.total_count || 0;
              comments = engRes.data.comments?.summary?.total_count || 0;
              shares = engRes.data.shares?.count || 0;
            } else if (profile.platform === 'instagram' && type !== 'story') {
              likes = post.like_count || 0;
              comments = post.comments_count || 0;
              shares = post.shares_count || 0;
            }
            await this.sleep(200);
          } catch (e) {}

          postPayloads.push({
            profileId: profile.profileId,
            postId: post.id,
            platform: profile.platform,
            postType: type,
            message: post.message || post.caption || '',
            mediaUrl:
              post.media_url ||
              post.attachments?.data?.[0]?.media?.source ||
              '',
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
            postedAt: new Date(
              post.created_time || post.timestamp || new Date(),
            ),
            likes,
            comments,
            shares,
            reach,
            views,
            clicks,
          });
        }

        if (postPayloads.length > 0)
          await this.postRepo.upsert(postPayloads, ['postId']);
        console.log(`[Worker] ✅ Chunk ${i + 1} complete!`);
        if (i < chunks - 1) await this.sleep(2000);
      }

      await this.profileRepo.update(
        { profileId: profile.profileId },
        { syncState: 'COMPLETED' },
      );
      console.log(
        `[Worker] Successfully finished ${totalDays}-day historical sync for ${job.data.profileId}.\n`,
      );
    } catch (error: any) {
      console.error(
        `[Worker] FATAL ERROR: Aborting sync for ${profile.profileId}. Error:`,
        error.message,
      );
      await this.profileRepo.update(
        { profileId: profile.profileId },
        {
          syncState: 'FAILED',
          lastSyncError: error.message,
        },
      );
    }
  }
}
