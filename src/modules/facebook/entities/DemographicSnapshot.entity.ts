import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('demographic_snapshots')
@Index(['profileId', 'date'], { unique: true })
export class DemographicSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  profileId: string;

  @Column({ type: 'date' })
  date: string;

  @Column()
  platform: string;

  /** Gender & age breakdown: { "M.25-34": 1234, "F.18-24": 567, ... } */
  @Column({ type: 'jsonb', default: {} })
  genderAge: Record<string, number>;

  /** Top cities: { "Mumbai, Maharashtra": 1234, ... } */
  @Column({ type: 'jsonb', default: {} })
  topCities: Record<string, number>;

  /** Top countries: { "IN": 5678, "US": 1234, ... } */
  @Column({ type: 'jsonb', default: {} })
  topCountries: Record<string, number>;
}
