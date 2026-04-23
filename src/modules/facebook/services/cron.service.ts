import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SocialProfile } from '../entities/SocialProfile.entity';
import { AnalyticsSnapshot } from '../entities/AnalyticsSnapshot.entity';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    @InjectRepository(SocialProfile)
    private profileRepo: Repository<SocialProfile>,
    @InjectRepository(AnalyticsSnapshot)
    private snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectQueue('social-sync-queue') private syncQueue: Queue,
  ) {}

  @Cron('0 16 * * *', { timeZone: 'Asia/Kolkata' })
  async handleDailySync4PM() {
    await this.handleDailySync();
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailySync() {
    this.logger.log(
      'Starting automated daily background sync for active profiles...',
    );

    // Check if any sync jobs are currently active or waiting in the queue.
    // If so, skip the entire daily sync to avoid interrupting ongoing imports.
    const activeJobCount = await this.syncQueue.getActiveCount();
    const waitingJobCount = await this.syncQueue.getWaitingCount();

    if (activeJobCount > 0 || waitingJobCount > 0) {
      this.logger.log(
        `Skipping daily sync entirely — ${activeJobCount} active and ${waitingJobCount} waiting job(s) in queue (likely an ongoing import).`,
      );
      return;
    }

    const activeProfiles = await this.profileRepo.find({
      where: { isActive: true },
    });

    for (const profile of activeProfiles) {
      if (profile.syncState === 'SYNCING') {
        this.logger.log(
          `Skipping daily sync for ${profile.profileId} as a sync is already in progress.`,
        );
        continue;
      }

      const latestSnapshot = await this.snapshotRepo.findOne({
        where: { profileId: profile.profileId },
        order: { date: 'DESC' },
      });

      let daysToFetch = 3;

      if (latestSnapshot) {
        const lastDate = new Date(latestSnapshot.date);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const diffTime = Math.abs(yesterday.getTime() - lastDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          daysToFetch = diffDays + 2;
        }
      }

      daysToFetch = Math.min(daysToFetch, 90);

      await this.profileRepo.update(
        { profileId: profile.profileId },
        { syncState: 'SYNCING' },
      );

      await this.syncQueue.add('initial-historical-sync', {
        profileId: profile.profileId,
        daysToFetch,
      });

      this.logger.log(
        `Queued daily sync for ${profile.profileId} (Fetching last ${daysToFetch} days)`,
      );
    }
  }
}
