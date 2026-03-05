import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('page_mappings')
export class PageMapping {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  category: string;

  @Column()
  platform: string;

  @Column()
  pageName: string;

  @Column()
  utmSource: string;

  @Column("text", { array: true })
  utmMediums: string[];
}