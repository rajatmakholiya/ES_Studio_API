import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DailyRevenue } from './entities/daily-revenue.entity';
import { RevenueMapping } from './entities/revenue-mapping.entity';
import { RevenueService } from './revenue.service';
import { RevenueController } from './revenue.controller';

@Module({
    imports: [TypeOrmModule.forFeature([DailyRevenue, RevenueMapping])],
    providers: [RevenueService],
    controllers: [RevenueController],
    exports: [TypeOrmModule] // <--- IMPORTANT: Export TypeOrmModule so Facebook module can use these repos
})
export class RevenueModule { }