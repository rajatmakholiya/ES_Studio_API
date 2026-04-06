import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';

import { SocialProfile } from './entities/SocialProfile.entity';
import { AnalyticsSnapshot } from './entities/AnalyticsSnapshot.entity';
import { SocialPost } from './entities/SocialPost.entity';
import { DemographicSnapshot } from './entities/DemographicSnapshot.entity';

import { AnalyticsController } from './controllers/analytics.controller';

import { CronService } from './services/cron.service';
import { SyncProcessor } from './workers/sync.processor';
import { AuthController } from './controllers/auth.Controller';
import { RevenueModule } from '../revenue/revenue.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SocialProfile,
      AnalyticsSnapshot,
      SocialPost,
      DemographicSnapshot,
    ]),
    BullModule.registerQueue({
      name: 'social-sync-queue',
    }),
    RevenueModule,
  ],
  controllers: [AnalyticsController, AuthController],
  providers: [CronService, SyncProcessor],
})
export class FacebookModule { }
