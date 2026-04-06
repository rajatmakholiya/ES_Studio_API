import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PageMappingsService } from './page-mappings.service';
import { PageMappingsController } from './page-mappings.controller';
import { PageMapping } from './entities/page-mapping.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PageMapping])],
  controllers: [PageMappingsController],
  providers: [PageMappingsService],
})
export class PageMappingsModule {}
