import { Controller, Post, Body, Res, Get } from '@nestjs/common';
import type { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';
import { SocialPost } from '../entities/SocialPost.entity';
import {
  exchangeForLongLivedToken,
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
      return res.status(200).json({ pages });
    } catch (error: any) {
      console.error('Fetch Pages Error:', error);
      return res.status(500).json({ error: 'Failed to fetch Meta accounts' });
    }
  }

  @Post('confirm-pages')
  async confirmPages(
    @Body() body: { selectedPages: any[] },
    @Res() res: Response,
  ) {
    try {
      const { selectedPages } = body;
      const profilePayloads = selectedPages.map((page: any) => ({
        profileId: page.id,
        name: page.name,
        platform: 'facebook',
        accessToken: page.access_token,
        isActive: true,
      }));

      await this.profileRepo.update(
        { platform: 'facebook' },
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
        message: 'Pages connected successfully. Data sync processed.',
      });
    } catch (error: any) {
      console.error('Confirm Pages Error:', error);
      return res.status(500).json({ error: 'Failed to save Meta accounts' });
    }
  }

  @Post('disconnect')
  async disconnectMeta(
    @Body() body: { deleteData: boolean },
    @Res() res: Response,
  ) {
    try {
      const { deleteData } = body;
      const fbProfiles = await this.profileRepo.find({
        where: { platform: 'facebook' },
      });
      const fbProfileIds = fbProfiles.map((p) => p.profileId);

      if (fbProfileIds.length > 0) {
        const jobs = await this.syncQueue.getJobs([
          'waiting',
          'active',
          'delayed',
          'paused',
        ]);

        for (const job of jobs) {
          if (job.data && fbProfileIds.includes(job.data.profileId)) {
            try {
              await job.remove();
            } catch (err) {}
          }
        }
      }

      if (deleteData) {
        await this.snapshotRepo.delete({ platform: 'facebook' });
        await this.postRepo.delete({ platform: 'facebook' });
        await this.profileRepo.delete({ platform: 'facebook' });
      } else {
        await this.profileRepo.update(
          { platform: 'facebook' },
          { isActive: false, syncState: 'DISCONNECTED' },
        );
      }

      return res.status(200).json({
        success: true,
        message: deleteData
          ? 'Successfully disconnected and deleted all Meta data.'
          : 'Successfully disconnected Meta accounts.',
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
