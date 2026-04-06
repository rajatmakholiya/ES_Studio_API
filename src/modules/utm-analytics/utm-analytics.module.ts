import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './utm-analytics.service';
import { AnalyticsController } from './utm-analytics.controller';
import { DailyAnalytics } from './entities/daily-analytics.entity';
import { BigQueryModule } from '../../common/bigquery/bigquery.module';

@Module({
  imports: [TypeOrmModule.forFeature([DailyAnalytics]), BigQueryModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class UtmAnalyticsModule {}
