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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), 
    
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost', 
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'postgres', 
      password: process.env.DB_PASSWORD || 'password', 
      database: process.env.DB_NAME || 'social_studio_db', 
      autoLoadEntities: true,
      synchronize: process.env.NODE_ENV !== 'production', 
    }),

    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: 6379,
      },
    }),
    AuthModule,
    FacebookModule,
    UtmAnalyticsModule,
    PageMappingsModule,
    BigQueryModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}