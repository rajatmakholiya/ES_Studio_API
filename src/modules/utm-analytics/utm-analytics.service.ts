import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { BigQueryService } from '../../common/bigquery/bigquery.service';
import { DailyAnalytics } from './entities/daily-analytics.entity';
import { subDays, format } from 'date-fns';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { Readable } from 'stream';

type Rollup = 'daily' | 'weekly' | 'monthly';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(DailyAnalytics)
    private readonly analyticsRepo: Repository<DailyAnalytics>,
    private readonly bq: BigQueryService,
  ) {}

  async getMetrics(
    rollup: Rollup,
    startDate: string,
    endDate: string,
    filters: any,
  ) {
    const qb = this.analyticsRepo.createQueryBuilder('a');
    qb.where(
      'a.date::date >= :startDate::date AND a.date::date <= :endDate::date',
      { startDate, endDate },
    );

    this.applyFilter(qb, 'utmSource', filters.utmSource);
    this.applyFilter(qb, 'utmMedium', filters.utmMedium);
    this.applyFilter(qb, 'utmCampaign', filters.utmCampaign);

    if (rollup === 'daily') {
      qb.select([
        "TO_CHAR(a.date, 'YYYY-MM-DD') as event_day",
        'a.utmSource as utm_source',
        'a.utmMedium as utm_medium',
        'a.utmCampaign as utm_campaign',
        'a.country as country',
        'a.city as city',
        'a.deviceCategory as device_category',
        'a.userGender as user_gender',
        'a.userAge as user_age',
        'SUM(a.sessions) as sessions',
        'SUM(a.pageviews) as pageviews',
        'SUM(a.users) as users',
        'SUM(a.newUsers) as new_users',
        'SUM(a.recurringUsers) as recurring_users',
        'SUM(a.identifiedUsers) as identified_users',
        'SUM(a.eventCount) as event_count',
        'AVG(a.engagementRate) as engagement_rate',
      ]);

      qb.groupBy("TO_CHAR(a.date, 'YYYY-MM-DD')");
      qb.addGroupBy('a.utmSource');
      qb.addGroupBy('a.utmMedium');
      qb.addGroupBy('a.utmCampaign');
      qb.addGroupBy('a.country');
      qb.addGroupBy('a.city');
      qb.addGroupBy('a.deviceCategory');
      qb.addGroupBy('a.userGender');
      qb.addGroupBy('a.userAge');
      qb.orderBy('event_day', 'ASC');
    } else {
      const timeBucket =
        rollup === 'weekly'
          ? "DATE_TRUNC('week', a.date::date)"
          : "DATE_TRUNC('month', a.date::date)";

      qb.select([
        `${timeBucket} as period`,
        'SUM(a.sessions) as sessions',
        'SUM(a.users) as users',
        'SUM(a.recurringUsers) as recurring_users',
        'SUM(a.identifiedUsers) as identified_users',
        'AVG(a.engagementRate) as engagement_rate',
      ]);
      qb.groupBy('period');
      qb.orderBy('period', 'ASC');
    }

    return await qb.getRawMany();
  }

  async getHeadlines(filters: { utmSource?: string | string[] } = {}) {
    const today = new Date();
    const yesterday = subDays(today, 1);
    const dayBeforeYesterday = subDays(today, 2);

    const last7Start = format(subDays(today, 7), 'yyyy-MM-dd');
    const last7End = format(yesterday, 'yyyy-MM-dd');
    const prev7Start = format(subDays(today, 14), 'yyyy-MM-dd');
    const prev7End = format(subDays(today, 8), 'yyyy-MM-dd');

    const [todayStats] = await this.getDateRangeStats(
      format(yesterday, 'yyyy-MM-dd'),
      format(yesterday, 'yyyy-MM-dd'),
      filters,
    );
    const [yesterdayStats] = await this.getDateRangeStats(
      format(dayBeforeYesterday, 'yyyy-MM-dd'),
      format(dayBeforeYesterday, 'yyyy-MM-dd'),
      filters,
    );
    const [thisWeekStats] = await this.getDateRangeStats(
      last7Start,
      last7End,
      filters,
    );
    const [lastWeekStats] = await this.getDateRangeStats(
      prev7Start,
      prev7End,
      filters,
    );

    return {
      daily: {
        date: format(yesterday, 'yyyy-MM-dd'),
        sessions: Number(todayStats?.sessions || 0),
        prevSessions: Number(yesterdayStats?.sessions || 0),
        diff: this.calculatePercentDiff(
          todayStats?.sessions,
          yesterdayStats?.sessions,
        ),
      },
      weekly: {
        range: `${last7Start} to ${last7End}`,
        sessions: Number(thisWeekStats?.sessions || 0),
        prevSessions: Number(lastWeekStats?.sessions || 0),
        diff: this.calculatePercentDiff(
          thisWeekStats?.sessions,
          lastWeekStats?.sessions,
        ),
      },
    };
  }

  /**
   * -------------------------------------------------------
   * 2. SYNC & IMPORT LAYER
   * -------------------------------------------------------
   */

  async importLegacyData(fileBuffer: Buffer) {
    this.logger.log('Starting Legacy Data Import via Streams...');

    const fileStream = Readable.from(fileBuffer);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isHeader = true;
    let batch: Partial<DailyAnalytics>[] = [];
    const BATCH_SIZE = 1500;
    let totalInserted = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;

      if (isHeader) {
        isHeader = false; // Skip the header row
        continue;
      }

      const values = this.parseCSVLine(line);

      // We expect exactly 18 columns based on your format:
      // 0: id, 1: date, 2: utmSource, 3: utmMedium, 4: utmCampaign, 
      // 5: sessions, 6: pageviews, 7: users, 8: newUsers, 9: eventCount, 
      // 10: engagementRate, 11: country, 12: city, 13: deviceCategory, 
      // 14: userGender, 15: userAge, 16: recurringUsers, 17: identifiedUsers
      if (values.length >= 18) {
        const date = values[1]?.trim();
        const utmSource = values[2]?.trim() || '(direct)';
        const utmMedium = values[3]?.trim() || '(none)';
        const utmCampaign = values[4]?.trim() || '(not set)';
        const sessions = Number(values[5]) || 0;
        const pageviews = Number(values[6]) || 0;
        const users = Number(values[7]) || 0;
        const newUsers = Number(values[8]) || 0;
        const eventCount = Number(values[9]) || 0;
        const engagementRate = Number(values[10]) || 0;
        const country = values[11]?.trim() || 'Unknown';
        const city = values[12]?.trim() || 'Unknown';
        const deviceCategory = values[13]?.trim() || 'Unknown';
        const userGender = values[14]?.trim() || 'Unknown';
        const userAge = values[15]?.trim() || 'Unknown';
        const recurringUsers = Number(values[16]) || 0;
        const identifiedUsers = Number(values[17]) || 0;

        // Skip rows where the date is missing
        if (!date) continue;

        // Generate the unique hash required by your DailyAnalytics entity to prevent duplicates
        const rawKey = `${date}|${utmSource}|${utmMedium}|${utmCampaign}|${country}|${city}|${deviceCategory}|${userGender}|${userAge}`;
        const dimensionHash = crypto.createHash('md5').update(rawKey).digest('hex');

        batch.push({
          dimensionHash,
          date,
          utmSource,
          utmMedium,
          utmCampaign,
          country,
          city,
          deviceCategory,
          userGender,
          userAge,
          sessions,
          pageviews,
          users,
          newUsers,
          recurringUsers,
          identifiedUsers,
          eventCount,
          engagementRate,
        });

        // Insert in batches of 1500 to keep memory low and DB queries fast
        if (batch.length >= BATCH_SIZE) {
          // Upsert means it will update existing records if you re-upload the same file, instead of crashing
          await this.analyticsRepo.upsert(batch, ['dimensionHash']);
          totalInserted += batch.length;
          this.logger.log(`Upserted ${totalInserted} legacy records...`);
          batch = [];
        }
      }
    }

    // Insert any remaining records that didn't fill the final batch
    if (batch.length > 0) {
      await this.analyticsRepo.upsert(batch, ['dimensionHash']);
      totalInserted += batch.length;
    }

    this.logger.log(`Legacy Import Complete. Total inserted/updated: ${totalInserted}`);
    return totalInserted;
  }

  @Cron('10 12 * * *', { timeZone: 'Asia/Kolkata' })
  async syncYesterdayData() {
    this.logger.log('Starting Daily Analytics Sync from BigQuery Stream...');

    const query = `
      SELECT
        date, utm_source, utm_medium, utm_campaign,
        country, city, device_category, user_gender, user_age,
        sessions, pageviews, users, new_users, recurring_users, identified_users, event_count, engagement_rate
      FROM \`bigquerytest-486307.analytics_266571177.utm_daily_metrics\`
      WHERE date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 3 DAY)
    `;

    try {
      const stream = await this.bq.queryStream(query);
      let batchMap = new Map<string, any>();
      const BATCH_SIZE = 1500;
      let totalProcessed = 0;

      const flushBatch = async () => {
        if (batchMap.size === 0) return;
        const batch = Array.from(batchMap.values());
        await this.analyticsRepo.upsert(batch, ['dimensionHash']);
        totalProcessed += batch.length;
        this.logger.log(`Upserted ${totalProcessed} records...`);
        batchMap.clear();
      };

      for await (const row of stream) {
        const date = row.date?.value || row.date;
        const utmSource = row.utm_source || '(direct)';
        const utmMedium = row.utm_medium || '(none)';
        const utmCampaign = row.utm_campaign || '(not set)';
        const country = row.country || 'Unknown';
        const city = row.city || 'Unknown';
        const deviceCategory = row.device_category || 'Unknown';
        const userGender = row.user_gender || 'Unknown';
        const userAge = row.user_age || 'Unknown';
        const rawKey = `${date}|${utmSource}|${utmMedium}|${utmCampaign}|${country}|${city}|${deviceCategory}|${userGender}|${userAge}`;
        const dimensionHash = crypto
          .createHash('md5')
          .update(rawKey)
          .digest('hex');

        if (!batchMap.has(dimensionHash)) {
          batchMap.set(dimensionHash, {
            dimensionHash,
            date,
            utmSource,
            utmMedium,
            utmCampaign,
            country,
            city,
            deviceCategory,
            userGender,
            userAge,
            sessions: 0,
            pageviews: 0,
            users: 0,
            newUsers: 0,
            recurringUsers: 0,
            identifiedUsers: 0,
            eventCount: 0,
            engagementRate: 0,
          });
        }

        const existingRow = batchMap.get(dimensionHash);
        existingRow.sessions += Number(row.sessions) || 0;
        existingRow.pageviews += Number(row.pageviews) || 0;
        existingRow.users += Number(row.users) || 0;
        existingRow.newUsers += Number(row.new_users) || 0;
        existingRow.recurringUsers += Number(row.recurring_users) || 0;
        existingRow.identifiedUsers += Number(row.identified_users) || 0;
        existingRow.eventCount += Number(row.event_count) || 0;
        existingRow.engagementRate =
          Number(row.engagement_rate) || existingRow.engagementRate;

        if (batchMap.size >= BATCH_SIZE) {
          await flushBatch();
        }
      }

      await flushBatch();
      this.logger.log('Daily Stream Sync Complete.');
    } catch (error) {
      this.logger.error('Stream Sync Failed:', error);
    }
  }

  /**
   * -------------------------------------------------------
   * 3. HELPER METHODS
   * -------------------------------------------------------
   */

  private extractParam(url: string, param: string): string | null {
    try {
      const match = url.match(new RegExp(`[?&]${param}=([^&]+)`));
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private parseCSVLine(text: string): string[] {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        inQuotes = !inQuotes;
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        if (field.startsWith('"') && field.endsWith('"'))
          field = field.slice(1, -1);
        result.push(field);
        start = i + 1;
      }
    }
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"'))
      lastField = lastField.slice(1, -1);
    result.push(lastField);
    return result;
  }

  private async getDateRangeStats(
    startDate: string,
    endDate: string,
    filters: { utmSource?: string | string[] },
  ) {
    const qb = this.analyticsRepo
      .createQueryBuilder('a')
      .select('SUM(a.sessions)', 'sessions')
      .addSelect('SUM(a.users)', 'users')
      .where('a.date BETWEEN :startDate AND :endDate', { startDate, endDate });
    this.applyFilter(qb, 'utmSource', filters.utmSource);
    return qb.getRawMany();
  }

  private calculatePercentDiff(current: number, previous: number) {
    if (!previous) return current > 0 ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(2));
  }

  private applyFilter(qb: any, column: string, value?: string | string[]) {
    if (!value) return;
    if (Array.isArray(value)) {
      qb.andWhere(`a.${column} IN (:...${column})`, { [column]: value });
    } else {
      qb.andWhere(`a.${column} = :${column}`, { [column]: value });
    }
  }
}
