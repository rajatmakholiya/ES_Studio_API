import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import { DailyAnalytics } from '../utm-analytics/entities/daily-analytics.entity';
import { PageMapping } from '../page-mappings/entities/page-mapping.entity';
import { DailyRevenue } from '../revenue/entities/daily-revenue.entity';
import { RevenueMapping } from '../revenue/entities/revenue-mapping.entity';
import { AnalyticsSnapshot } from '../facebook/entities/AnalyticsSnapshot.entity';
import { SocialProfile } from '../facebook/entities/SocialProfile.entity';
import { SocialPost } from '../facebook/entities/SocialPost.entity';

@Injectable()
export class CsvGeneratorService {
    private readonly logger = new Logger(CsvGeneratorService.name);

    constructor(
        @InjectRepository(DailyAnalytics)
        private readonly utmRepo: Repository<DailyAnalytics>,
        @InjectRepository(PageMapping)
        private readonly pageMappingRepo: Repository<PageMapping>,
        @InjectRepository(DailyRevenue)
        private readonly dailyRevenueRepo: Repository<DailyRevenue>,
        @InjectRepository(RevenueMapping)
        private readonly revenueMappingRepo: Repository<RevenueMapping>,
        @InjectRepository(AnalyticsSnapshot)
        private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
        @InjectRepository(SocialProfile)
        private readonly profileRepo: Repository<SocialProfile>,
        @InjectRepository(SocialPost)
        private readonly postRepo: Repository<SocialPost>,
    ) {}

    // ─────────────────────────────────────────────────────
    // 1. WEB TRAFFIC CSV
    // ─────────────────────────────────────────────────────
    async generateTrafficCSV(startDate: string, endDate: string): Promise<string> {
        this.logger.log(`Generating Traffic CSV for ${startDate} to ${endDate}`);

        const mappings = await this.pageMappingRepo.find();

        // Query UTM analytics grouped by medium
        const rows = await this.utmRepo.createQueryBuilder('a')
            .select([
                'a.utmMedium as utm_medium',
                'SUM(a.sessions) as sessions',
                'SUM(a.users) as users',
                'SUM(a.pageviews) as pageviews',
                'AVG(a.engagementRate) as engagement_rate',
                'SUM(a.recurringUsers) as recurring_users',
                'SUM(a.newUsers) as new_users',
                'SUM(a.eventCount) as event_count',
            ])
            .where(`a.date::date >= :startDate::date AND a.date::date <= :endDate::date`,
                { startDate, endDate })
            .andWhere(
                `(a.utmSource ILIKE '%face%' OR a.utmSource ILIKE '%ig%' OR a.utmSource ILIKE '%insta%' OR a.utmSource IN ('fb', 'Fb'))`,
            )
            .groupBy('a.utmMedium')
            .orderBy('sessions', 'DESC')
            .getRawMany();

        // Map UTM mediums to page names using page-mappings
        const mediumToPage = new Map<string, { pageName: string; category: string; team: string }>();
        for (const mapping of mappings) {
            for (const medium of mapping.utmMediums) {
                mediumToPage.set(medium.toLowerCase(), {
                    pageName: mapping.pageName,
                    category: mapping.category,
                    team: mapping.team || 'Unassigned',
                });
            }
        }

        const csvRows: string[] = [
            'Page Name,Category,Team,Sessions,Users,Pageviews,Engagement Rate,Recurring Users,New Users,Event Count',
        ];

        for (const row of rows) {
            const medium = (row.utm_medium || '').toLowerCase();
            const info = mediumToPage.get(medium);
            const pageName = info?.pageName || row.utm_medium || 'Unknown';
            const category = info?.category || 'Uncategorized';
            const team = info?.team || 'Unassigned';

            csvRows.push([
                this.escapeCSV(pageName),
                this.escapeCSV(category),
                this.escapeCSV(team),
                Number(row.sessions || 0),
                Number(row.users || 0),
                Number(row.pageviews || 0),
                `${Number(row.engagement_rate || 0).toFixed(2)}%`,
                Number(row.recurring_users || 0),
                Number(row.new_users || 0),
                Number(row.event_count || 0),
            ].join(','));
        }

        return csvRows.join('\n');
    }

    // ─────────────────────────────────────────────────────
    // 2. REVENUE CSV (pivot format)
    // ─────────────────────────────────────────────────────
    async generateRevenueCSV(startDate: string, endDate: string): Promise<string> {
        this.logger.log(`Generating Revenue CSV for ${startDate} to ${endDate}`);

        const rows = await this.dailyRevenueRepo
            .createQueryBuilder('dr')
            .select([
                'rm.pageName AS "pageName"',
                'rm.team AS "team"',
                'SUM(dr.bonusRevenue) AS "bonus"',
                'SUM(dr.photoRevenue) AS "photo"',
                'SUM(dr.reelRevenue) AS "reel"',
                'SUM(dr.storyRevenue) AS "story"',
                'SUM(dr.textRevenue) AS "text"',
                'SUM(dr.totalRevenue) AS "total"',
            ])
            .innerJoin(RevenueMapping, 'rm', 'rm.pageId = dr.pageId')
            .where('dr.date >= :startDate', { startDate })
            .andWhere('dr.date <= :endDate', { endDate })
            .groupBy('rm.pageName, rm.team')
            .orderBy('"team"', 'ASC')
            .addOrderBy('"pageName"', 'ASC')
            .getRawMany();

        // Group by team for pivot structure
        const teamGroups = new Map<string, { pages: typeof rows; totals: any }>();

        for (const row of rows) {
            const team = row.team || 'Unassigned';
            if (!teamGroups.has(team)) {
                teamGroups.set(team, {
                    pages: [],
                    totals: { bonus: 0, photo: 0, reel: 0, story: 0, text: 0, total: 0 },
                });
            }
            const group = teamGroups.get(team)!;
            group.pages.push(row);
            group.totals.bonus += Number(row.bonus || 0);
            group.totals.photo += Number(row.photo || 0);
            group.totals.reel += Number(row.reel || 0);
            group.totals.story += Number(row.story || 0);
            group.totals.text += Number(row.text || 0);
            group.totals.total += Number(row.total || 0);
        }

        const csvRows: string[] = [
            'Team / Page,Bonus,Photo,Reel,Story,Text,Total',
        ];

        let grandTotal = { bonus: 0, photo: 0, reel: 0, story: 0, text: 0, total: 0 };

        for (const [team, group] of teamGroups) {
            const t = group.totals;
            grandTotal.bonus += t.bonus;
            grandTotal.photo += t.photo;
            grandTotal.reel += t.reel;
            grandTotal.story += t.story;
            grandTotal.text += t.text;
            grandTotal.total += t.total;

            // Team total row
            csvRows.push([
                this.escapeCSV(`${team} (Total)`),
                this.fmtMoney(t.bonus),
                this.fmtMoney(t.photo),
                this.fmtMoney(t.reel),
                this.fmtMoney(t.story),
                this.fmtMoney(t.text),
                this.fmtMoney(t.total),
            ].join(','));

            // Individual page rows
            for (const page of group.pages) {
                csvRows.push([
                    this.escapeCSV(`  ${page.pageName}`),
                    this.fmtMoney(page.bonus),
                    this.fmtMoney(page.photo),
                    this.fmtMoney(page.reel),
                    this.fmtMoney(page.story),
                    this.fmtMoney(page.text),
                    this.fmtMoney(page.total),
                ].join(','));
            }
        }

        // Grand total row
        csvRows.push([
            'Grand Total',
            this.fmtMoney(grandTotal.bonus),
            this.fmtMoney(grandTotal.photo),
            this.fmtMoney(grandTotal.reel),
            this.fmtMoney(grandTotal.story),
            this.fmtMoney(grandTotal.text),
            this.fmtMoney(grandTotal.total),
        ].join(','));

        return csvRows.join('\n');
    }

    // ─────────────────────────────────────────────────────
    // 3. META/REPORTS CSV (aggregate overview metrics)
    // ─────────────────────────────────────────────────────
    async generateMetaReportCSV(startDate: string, endDate: string): Promise<string> {
        this.logger.log(`Generating Meta Report CSV for ${startDate} to ${endDate}`);

        const profiles = await this.profileRepo.find({ where: { isActive: true } });
        const profileIds = profiles.map(p => p.profileId);

        if (profileIds.length === 0) {
            return 'Metric,Value,Change (%)\nNo active profiles found,,';
        }

        // Compute previous period for comparison
        const startD = new Date(startDate);
        const endD = new Date(endDate);
        const daysSpan = Math.round((endD.getTime() - startD.getTime()) / (86400000)) + 1;
        const prevEnd = new Date(startD);
        prevEnd.setDate(prevEnd.getDate() - 1);
        const prevStart = new Date(prevEnd);
        prevStart.setDate(prevStart.getDate() - daysSpan + 1);

        const prevStartStr = prevStart.toISOString().split('T')[0];
        const prevEndStr = prevEnd.toISOString().split('T')[0];

        // Current period snapshots
        const currentSnapshots = await this.snapshotRepo.find({
            where: { profileId: In(profileIds), date: Between(startDate, endDate) },
        });

        const prevSnapshots = await this.snapshotRepo.find({
            where: { profileId: In(profileIds), date: Between(prevStartStr, prevEndStr) },
        });

        // Current period posts
        const currentPosts = await this.postRepo.find({
            where: {
                profileId: In(profileIds),
                postedAt: Between(new Date(startDate), new Date(endDate + 'T23:59:59')),
            },
        });

        const prevPosts = await this.postRepo.find({
            where: {
                profileId: In(profileIds),
                postedAt: Between(new Date(prevStartStr), new Date(prevEndStr + 'T23:59:59')),
            },
        });

        // Aggregate current period
        let currentFollowersGained = 0, currentUnfollows = 0, currentImpressions = 0;
        let currentEngagements = 0, currentPageViews = 0, currentMessages = 0;
        let currentVideoViews = 0, currentRevenue = 0;

        for (const snap of currentSnapshots) {
            currentFollowersGained += Number(snap.followersGained || 0);
            currentUnfollows += Number(snap.unfollows || 0);
            currentImpressions += Number(snap.totalImpressions || snap.totalReach || 0);
            currentEngagements += Number(snap.totalEngagement || 0);
            currentPageViews += Number(snap.pageViews || 0);
            currentMessages += Number(snap.netMessages || 0);
            currentRevenue += Number(snap.revenue || 0);
            if (snap.platform === 'facebook') {
                currentVideoViews += Number(snap.videoViews || 0);
            }
        }

        for (const post of currentPosts) {
            const postEng = Number(post.likes || 0) + Number(post.comments || 0)
                + Number(post.shares || 0) + Number(post.clicks || 0);
            currentEngagements += postEng;
            if (post.platform === 'instagram') {
                currentVideoViews += Number(post.views || 0);
                currentImpressions += Number(post.views || 0) + Number(post.reach || 0);
            } else if (post.platform === 'facebook') {
                currentImpressions += Number(post.reach || 0);
            }
        }

        const currentNetGrowth = currentFollowersGained - currentUnfollows;
        const currentEngRate = currentImpressions > 0
            ? (currentEngagements / currentImpressions) * 100 : 0;

        // Aggregate previous period
        let prevFollowersGained = 0, prevUnfollows = 0, prevImpressions = 0;
        let prevEngagements = 0, prevPageViews = 0, prevMessages = 0;
        let prevVideoViews = 0, prevRevenue = 0;

        for (const snap of prevSnapshots) {
            prevFollowersGained += Number(snap.followersGained || 0);
            prevUnfollows += Number(snap.unfollows || 0);
            prevImpressions += Number(snap.totalImpressions || snap.totalReach || 0);
            prevEngagements += Number(snap.totalEngagement || 0);
            prevPageViews += Number(snap.pageViews || 0);
            prevMessages += Number(snap.netMessages || 0);
            prevRevenue += Number(snap.revenue || 0);
            if (snap.platform === 'facebook') {
                prevVideoViews += Number(snap.videoViews || 0);
            }
        }

        for (const post of prevPosts) {
            prevEngagements += Number(post.likes || 0) + Number(post.comments || 0)
                + Number(post.shares || 0) + Number(post.clicks || 0);
            if (post.platform === 'instagram') {
                prevVideoViews += Number(post.views || 0);
                prevImpressions += Number(post.views || 0) + Number(post.reach || 0);
            } else if (post.platform === 'facebook') {
                prevImpressions += Number(post.reach || 0);
            }
        }

        const prevNetGrowth = prevFollowersGained - prevUnfollows;
        const prevEngRate = prevImpressions > 0 ? (prevEngagements / prevImpressions) * 100 : 0;

        // Get current total audience
        let currentAudience = 0;
        for (const pid of profileIds) {
            const latest = await this.snapshotRepo.findOne({
                where: { profileId: pid },
                order: { date: 'DESC' },
            });
            if (latest && latest.totalFollowers > 0) currentAudience += latest.totalFollowers;
        }
        const prevAudience = currentAudience - currentNetGrowth;

        const calcChange = (cur: number, prev: number): string => {
            if (prev === 0) return cur > 0 ? '+100.0%' : cur < 0 ? '-100.0%' : '0.0%';
            const pct = ((cur - prev) / Math.abs(prev)) * 100;
            return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
        };

        const csvRows: string[] = [
            'Metric,Value,Change (%)',
            `Total Audience,${currentAudience.toLocaleString()},${calcChange(currentAudience, prevAudience)}`,
            `Net Followers,${currentNetGrowth >= 0 ? '+' : ''}${currentNetGrowth.toLocaleString()},${calcChange(currentNetGrowth, prevNetGrowth)}`,
            `Impressions,${currentImpressions.toLocaleString()},${calcChange(currentImpressions, prevImpressions)}`,
            `Engagements,${currentEngagements.toLocaleString()},${calcChange(currentEngagements, prevEngagements)}`,
            `Engagement Rate,${currentEngRate.toFixed(1)}%,${calcChange(currentEngRate, prevEngRate)}`,
            `Page Views,${currentPageViews.toLocaleString()},${calcChange(currentPageViews, prevPageViews)}`,
            `Video Views,${currentVideoViews.toLocaleString()},${calcChange(currentVideoViews, prevVideoViews)}`,
            `Messages,${currentMessages.toLocaleString()},${calcChange(currentMessages, prevMessages)}`,
            `Revenue,$${currentRevenue.toFixed(2)},${calcChange(currentRevenue, prevRevenue)}`,
        ];

        return csvRows.join('\n');
    }

    // ─────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────
    private escapeCSV(value: string): string {
        if (value.includes(',') || value.includes('"') || value.includes('\n')) {
            return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
    }

    private fmtMoney(value: any): string {
        return `$${Number(value || 0).toFixed(2)}`;
    }
}
