import {
  Controller,
  Get,
  Post,
  Query,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AnalyticsService } from './utm-analytics.service';

@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('utm/metrics')
  async getUtmMetrics(
    @Query('rollup') rollup: 'daily' | 'weekly' | 'monthly',
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('utmSource') utmSource?: string | string[],
    @Query('utmMedium') utmMedium?: string | string[],
    @Query('utmCampaign') utmCampaign?: string | string[],
  ) {
    if (!rollup || !startDate || !endDate) {
      throw new HttpException('Missing params', HttpStatus.BAD_REQUEST);
    }

    const filters = {
      utmSource: this.normalizeArray(utmSource),
      utmMedium: this.normalizeArray(utmMedium),
      utmCampaign: this.normalizeArray(utmCampaign),
    };

    return await this.analyticsService.getMetrics(
      rollup,
      startDate,
      endDate,
      filters,
    );
  }

  @Get('headlines')
  async getHeadlines(@Query('utmSource') utmSource?: string | string[]) {
    const filters = {
      utmSource: this.normalizeArray(utmSource),
    };
    return await this.analyticsService.getHeadlines(filters);
  }

  @Post('sync/manual')
  async triggerManualSync() {
    await this.analyticsService.syncYesterdayData();
    return { status: 'success', message: 'Sync started' };
  }

  @Post('import/legacy')
  @UseInterceptors(FileInterceptor('file'))
  async importLegacyData(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No CSV file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const count = await this.analyticsService.importLegacyData(file.buffer);
      return {
        status: 'success',
        message: `Imported ${count} legacy records successfully.`,
      };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private normalizeArray(param?: string | string[]): string[] | undefined {
    if (!param) return undefined;
    return Array.isArray(param) ? param : [param];
  }
}
