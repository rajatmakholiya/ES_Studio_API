import { Controller, Get, Patch, Param, Body, Query } from '@nestjs/common';
import { RevenueService } from './revenue.service';

@Controller('v1/revenue')
export class RevenueController {
    constructor(private readonly revenueService: RevenueService) { }

    @Get('metrics')
    async getMetrics(
        @Query('startDate') startDate: string,
        @Query('endDate') endDate: string,
    ) {
        return this.revenueService.getAggregatedMetrics(startDate, endDate);
    }

    @Get('mappings')
    async getMappings() {
        return this.revenueService.getMappings();
    }

    /**
     * Batch-update the team for multiple revenue-mapping IDs at once.
     * Body: { ids: number[], team: string | null }
     * Returns the full updated mappings list.
     *
     * MUST be declared BEFORE the :id route.
     */
    @Patch('mappings/batch/team')
    async batchUpdateTeam(@Body() body: { ids: number[]; team: string | null }) {
        const { ids, team } = body;
        if (!Array.isArray(ids) || ids.length === 0) return this.revenueService.getMappings();
        for (const id of ids) {
            await this.revenueService.updateMappingTeam(id, team);
        }
        return this.revenueService.getMappings();
    }

    @Patch('mappings/:id')
    async updateMapping(@Param('id') id: string, @Body() body: { team: string | null }) {
        return this.revenueService.updateMappingTeam(Number(id), body.team);
    }
}