import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PageMapping } from './entities/page-mapping.entity';
import { Readable } from 'stream';
import * as readline from 'readline';

@Injectable()
export class PageMappingsService {
  constructor(
    @InjectRepository(PageMapping)
    private mappingRepository: Repository<PageMapping>,
  ) {}

  findAll() {
    return this.mappingRepository.find({
      order: { category: 'ASC', pageName: 'ASC' },
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

  async importFromCSV(fileBuffer: Buffer) {
    const fileStream = Readable.from(fileBuffer);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let isHeader = true;
    const mappings: Partial<PageMapping>[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      if (isHeader) {
        isHeader = false;
        continue;
      }

      const values = this.parseCSVLine(line);

      if (values.length >= 6) {
        const [id, category, platform, pageName, utmSource, utmMediumsStr] =
          values;

        let cleanedMediumsStr = utmMediumsStr || '';
        cleanedMediumsStr = cleanedMediumsStr.replace(/^\{|\}$/g, '');

        const mediumsArray = cleanedMediumsStr
          .split(',')
          .map((m) => {
            let trimmed = m.trim();

            if (trimmed.includes('utm_medium=')) {
              const paramString = trimmed.includes('?')
                ? trimmed.substring(trimmed.indexOf('?'))
                : trimmed;
              const urlParams = new URLSearchParams(paramString);
              trimmed = urlParams.get('utm_medium') || trimmed;
            }
            return trimmed;
          })
          .filter(Boolean);

        mappings.push({
          category: category?.trim(),
          platform: platform?.trim(),
          pageName: pageName?.trim(),
          utmSource: utmSource?.trim(),
          utmMediums: mediumsArray,
        });
      }
    }

    if (mappings.length > 0) {
      await this.mappingRepository.save(mappings);
    }

    return mappings.length;
  }

  private parseCSVLine(text: string): string[] {
    const result: string[] = [];
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        inQuotes = !inQuotes;
      } else if (text[i] === ',' && !inQuotes) {
        let field = text.substring(start, i).trim();
        if (field.startsWith('"') && field.endsWith('"'))
          field = field.slice(1, -1);
        result.push(field);
        start = i + 1;
      }
    }
    let lastField = text.substring(start).trim();
    if (lastField.startsWith('"') && lastField.endsWith('"'))
      lastField = lastField.slice(1, -1);
    result.push(lastField);
    return result;
  }
}
