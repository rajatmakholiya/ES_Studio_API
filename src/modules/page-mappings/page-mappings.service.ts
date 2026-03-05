import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PageMapping } from './entities/page-mapping.entity';

@Injectable()
export class PageMappingsService {
  constructor(
    @InjectRepository(PageMapping)
    private mappingRepository: Repository<PageMapping>,
  ) {}

  findAll() {
    return this.mappingRepository.find({
        order: { category: 'ASC', pageName: 'ASC' }
    });
  }

  create(mapping: Partial<PageMapping>) {
    const newMapping = this.mappingRepository.create(mapping);
    return this.mappingRepository.save(newMapping);
  }

  async remove(id: number) {
    await this.mappingRepository.delete(id);
    return { deleted: true };
  }
}