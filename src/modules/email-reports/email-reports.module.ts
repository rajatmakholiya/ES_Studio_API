import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportRecipient } from './entities/report-recipient.entity';
import { EmailReportsController } from './email-reports.controller';
import { EmailReportsService } from './email-reports.service';
import { CsvGeneratorService } from './csv-generators.service';

// Import entities from other modules directly (their TypeOrmModules are
// registered globally via autoLoadEntities, so we just need the repos)
import { DailyAnalytics } from '../utm-analytics/entities/daily-analytics.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import { DailyRevenue } from '../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../revenue/entities/revenue-mapping.entity';
import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ReportRecipient,
            // Entities from other modules — we register repos here since
            // autoLoadEntities handles schema discovery globally
            DailyAnalytics,
            PageMapping,
            DailyRevenue,
            RevenueMapping,
            AnalyticsSnapshot,
            SocialProfile,
            SocialPost,
        ]),
    ],
    controllers: [EmailReportsController],
    providers: [EmailReportsService, CsvGeneratorService],
    exports: [EmailReportsService],
})
export class EmailReportsModule {}
