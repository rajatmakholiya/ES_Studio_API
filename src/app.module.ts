import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { FacebookModule } from './modules/facebook/facebook.module';
import { PageMappingsModule } from './modules/page-mappings/page-mappings.module';
import { BigQueryModule } from './common/bigquery/bigquery.module';
import { UtmAnalyticsModule } from './modules/utm-analytics/utm-analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { RevenueModule } from './modules/revenue/revenue.module';
import { EmailReportsModule } from './modules/email-reports/email-reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),

    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'password',
      database: process.env.DB_NAME || 'social_studio_db',
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV !== 'production',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    }),

    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      },
    }),
    AuthModule,
    FacebookModule,
    UtmAnalyticsModule,
    PageMappingsModule,
    BigQueryModule,
    RevenueModule,
    EmailReportsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
