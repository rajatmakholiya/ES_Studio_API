import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PageMappingsService } from './page-mappings.service';
import { PageMapping } from './entities/page-mapping.entity';

@Controller('page-mappings')
export class PageMappingsController {
  constructor(private readonly service: PageMappingsService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() mapping: Partial<PageMapping>) {
    return this.service.create(mapping);
  }

  /**
   * Batch-update the `team` field for multiple mapping IDs at once.
   * Body: { ids: number[], team: string | null }
   * Returns the full updated mappings list.
   *
   * MUST be declared BEFORE the `:id` routes so NestJS matches the literal
   * path segment "batch" rather than treating it as a numeric :id param.
   */
  @Patch('batch/team')
  async batchUpdateTeam(@Body() body: { ids: number[]; team: string | null }) {
    const { ids, team } = body;
    if (!Array.isArray(ids) || ids.length === 0) return this.service.findAll();
    for (const id of ids) {
      await this.service.update(id, { team });
    }
    return this.service.findAll();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() mapping: Partial<PageMapping>) {
    return this.service.update(+id, mapping);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importCSV(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No CSV file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const count = await this.service.importFromCSV(file.buffer);
      return {
        status: 'success',
        message: `Imported ${count} page mappings successfully.`,
      };
    } catch (error) {
      throw new HttpException(
        error instanceof Error ? error.message : 'Import failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
