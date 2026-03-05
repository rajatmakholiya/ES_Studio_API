import {
  Controller,
  Get,
  Post,
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

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
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
