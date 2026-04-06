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

    @Patch('mappings/:id')
    async updateMapping(@Param('id') id: string, @Body() body: { team: string | null }) {
        return this.revenueService.updateMappingTeam(Number(id), body.team);
    }
}