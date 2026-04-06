import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyRevenue } from './entities/daily-revenue.entity';
import { RevenueMapping } from './entities/revenue-mapping.entity';

@Injectable()
export class RevenueService {
    constructor(
        @InjectRepository(DailyRevenue)
        private dailyRevenueRepo: Repository<DailyRevenue>,
        @InjectRepository(RevenueMapping)
        private mappingRepo: Repository<RevenueMapping>,
    ) { }

    // ---- MAPPINGS API ----
    async getMappings() {
        return this.mappingRepo.find({ order: { team: 'ASC', pageName: 'ASC' } });
    }

    async updateMappingTeam(id: number, team: string | null) {
        await this.mappingRepo.update(id, { team: team || 'Unassigned' });
        return this.getMappings();
    }

    // ---- FRONTEND DASHBOARD API ----
    async getAggregatedMetrics(startDate: string, endDate: string) {
        return this.dailyRevenueRepo
            .createQueryBuilder('dr')
            .select([
                'dr.date AS "date"',
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
            .groupBy('dr.date, rm.pageName, rm.team')
            .orderBy('dr.date', 'DESC')
            .getRawMany();
    }
}