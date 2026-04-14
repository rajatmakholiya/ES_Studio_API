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

  async findAll() {
    // One-shot cleanup: normalise any empty-string team values to NULL.
    // Previous frontend code sometimes sent "" or undefined instead of null,
    // leaving rows that look "assigned" but group separately from real nulls.
    await this.mappingRepository
      .createQueryBuilder()
      .update()
      .set({ team: null })
      .where("team = ''")
      .orWhere("TRIM(team) = ''")
      .execute();

    return this.mappingRepository.find({
      order: { category: 'ASC', pageName: 'ASC' },
    });
  }

  create(mapping: Partial<PageMapping>) {
    const newMapping = this.mappingRepository.create(mapping);
    return this.mappingRepository.save(newMapping);
  }

  async update(id: number, partial: Partial<PageMapping>) {
    // Normalise the team value: empty strings, whitespace-only, and undefined
    // should all be stored as null (= "Unassigned" in the UI).  Without this,
    // TypeORM skips `undefined` fields entirely (no DB write) and stores `""`
    // as a non-null string that doesn't group with null.
    if ('team' in partial) {
      const t = partial.team;
      partial.team = (typeof t === 'string' && t.trim()) ? t.trim() : null;
    }
    await this.mappingRepository.update(id, partial);
    return this.mappingRepository.findOneBy({ id });
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
        // Support both old format (no team) and new format (with team as 3rd col)
        // Old: id, category, platform, pageName, utmSource, utmMediums
        // New: id, category, team, platform, pageName, utmSource, utmMediums
        let category: string, team: string | null, platform: string, pageName: string, utmSource: string, utmMediumsStr: string;

        if (values.length >= 7) {
          // New format: team is 3rd column
          [, category, team, platform, pageName, utmSource, utmMediumsStr] = values;
        } else {
          // Old format: no team column
          [, category, platform, pageName, utmSource, utmMediumsStr] = values;
          team = null;
        }

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
          team: team?.trim() || null,
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
