import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('analytics_snapshots')
@Index(['profileId', 'date'], { unique: true })
export class AnalyticsSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  profileId: string;

  @Column({ type: 'date' })
  date: string;

  @Column()
  platform: string;

  @Column({ type: 'int', default: 0 })
  totalFollowers: number;

  @Column({ type: 'int', default: 0 })
  followersGained: number;

  @Column({ type: 'int', default: 0 })
  unfollows: number;

  @Column({ type: 'int', default: 0 })
  totalReach: number;

  @Column({ type: 'int', default: 0 })
  totalImpressions: number;

  @Column({ type: 'int', default: 0 })
  videoViews: number;

  @Column({ type: 'int', default: 0 })
  totalEngagement: number;

  @Column({ type: 'int', default: 0 })
  profileClicks: number;

  @Column({ type: 'int', default: 0 })
  pageViews: number;

  @Column({ type: 'int', default: 0 })
  netMessages: number;

  @Column({ type: 'jsonb', nullable: true })
  demographics: any;
}