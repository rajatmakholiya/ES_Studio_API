import { Controller, Post, Body, Res, Get } from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import { DemographicSnapshot } from '../entities/DemographicSnapshot.entity';
import { DailyRevenue } from '../../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../../revenue/entities/revenue-mapping.entity';
import {
  exchangeForLongLivedToken,
  fetchLinkedInstagramAccounts,
  fetchPermanentPageTokens,
} from '../services/meta.service';

@Controller('api/auth/meta')
export class AuthController {
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
    @InjectQueue('social-sync-queue') private syncQueue: Queue,
  ) {}

  @Post('fetch-pages')
  async fetchPages(
    @Body() body: { shortLivedToken: string },
    @Res() res: Response,
  ) {
    try {
      const { shortLivedToken } = body;
      const longLivedToken = await exchangeForLongLivedToken(shortLivedToken);
      const pages = await fetchPermanentPageTokens('me', longLivedToken);

      const igAccounts = await fetchLinkedInstagramAccounts(pages);

      return res.status(200).json({ pages, igAccounts });
    } catch (error: any) {
      console.error('Fetch Pages Error:', error);
      return res.status(500).json({ error: 'Failed to fetch Meta accounts' });
    }
  }

  @Post('confirm-pages')
  async confirmPages(
    @Body() body: { selectedPages?: any[]; selectedIgAccounts?: any[] },
    @Res() res: Response,
  ) {
    try {
      const { selectedPages = [], selectedIgAccounts = [] } = body;

      const profilePayloads: any[] = [];

      selectedPages.forEach((page: any) => {
        profilePayloads.push({
          profileId: page.id,
          name: page.name,
          platform: 'facebook',
          accessToken: page.access_token,
          isActive: true,
        });
      });

      selectedIgAccounts.forEach((ig: any) => {
        profilePayloads.push({
          profileId: ig.id,
          name: ig.name,
          platform: 'instagram',
          accessToken: ig.access_token,
          isActive: true,
        });
      });

      await this.profileRepo.update(
        { platform: 'facebook' },
        { isActive: false },
      );
      await this.profileRepo.update(
        { platform: 'instagram' },
        { isActive: false },
      );

      if (profilePayloads.length > 0) {
        await this.profileRepo.upsert(profilePayloads, ['profileId']);

        const eightyFiveDaysAgo = new Date();
        eightyFiveDaysAgo.setDate(eightyFiveDaysAgo.getDate() - 85);

        for (const profile of profilePayloads) {
          const oldestSnapshot = await this.snapshotRepo.findOne({
            where: { profileId: profile.profileId },
            order: { date: 'ASC' },
          });

          let needsSync = true;
          if (oldestSnapshot) {
            const oldestDate = new Date(oldestSnapshot.date);
            if (oldestDate <= eightyFiveDaysAgo) {
              needsSync = false;
            }
          }

          if (needsSync) {
            await this.syncQueue.add(
              'initial-historical-sync',
              { profileId: profile.profileId },
              { attempts: 3, backoff: 5000 },
            );
          } else {
            await this.profileRepo.update(
              { profileId: profile.profileId },
              { syncState: 'COMPLETED' },
            );
          }
        }
      }
      return res.status(200).json({
        success: true,
        message:
          'Pages and Accounts connected successfully. Data sync processed.',
      });
    } catch (error: any) {
      console.error('Confirm Pages Error:', error);
      return res.status(500).json({ error: 'Failed to save Meta accounts' });
    }
  }

  @Post('disconnect')
  async disconnectMeta(
    @Body()
    body: { deleteData: boolean; platform?: 'facebook' | 'instagram' | 'all' },
    @Res() res: Response,
  ) {
    try {
      const { deleteData, platform = 'all' } = body;

      const platformQuery =
        platform === 'all' ? In(['facebook', 'instagram']) : platform;

      const profiles = await this.profileRepo.find({
        where: { platform: platformQuery },
      });
      const profileIds = profiles.map((p) => p.profileId);

      if (profileIds.length > 0) {
        const jobs = await this.syncQueue.getJobs([
          'waiting',
          'active',
          'delayed',
          'paused',
        ]);
        for (const job of jobs) {
          if (job.data && profileIds.includes(job.data.profileId)) {
            try {
              await job.remove();
            } catch (err) {}
          }
        }
      }

      if (deleteData) {
        // Delete revenue data for the affected Facebook pages
        if (platform === 'all' || platform === 'facebook') {
          const fbProfiles = profiles.filter((p) => p.platform === 'facebook');
          const fbPageIds = fbProfiles.map((p) => p.profileId);
          if (fbPageIds.length > 0) {
            await this.dailyRevenueRepo.delete({ pageId: In(fbPageIds) });
            await this.revenueMappingRepo.delete({ pageId: In(fbPageIds) });
          }
        }

        await this.demographicRepo.delete({ platform: platformQuery as any });
        await this.snapshotRepo.delete({ platform: platformQuery as any });
        await this.postRepo.delete({ platform: platformQuery as any });
        await this.profileRepo.delete({ platform: platformQuery as any });
      } else {
        await this.profileRepo.update(
          { platform: platformQuery as any },
          { isActive: false, syncState: 'DISCONNECTED' },
        );
      }

      return res.status(200).json({
        success: true,
        message: deleteData
          ? `Successfully disconnected and deleted data for ${platform}.`
          : `Successfully disconnected ${platform} accounts.`,
      });
    } catch (error: any) {
      console.error('Disconnect Meta Error:', error);
      return res
        .status(500)
        .json({ error: 'Failed to disconnect Meta accounts' });
    }
  }

  @Get('sync-status')
  async getSyncStatus(@Res() res: Response) {
    const active = await this.syncQueue.getActiveCount();
    const waiting = await this.syncQueue.getWaitingCount();
    const totalJobs = active + waiting;

    return res.status(200).json({
      isSyncing: totalJobs > 0,
      jobsRemaining: totalJobs,
    });
  }
}
