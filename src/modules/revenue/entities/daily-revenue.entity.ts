import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

// Idempotent: ensures we safely update existing days during historical syncs
@Unique(['pageId', 'date'])
@Entity('daily_revenue')
export class DailyRevenue {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    pageId: string;

    @Column({ type: 'date' })
    date: string;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    bonusRevenue: number;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    photoRevenue: number;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    reelRevenue: number;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    storyRevenue: number;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    textRevenue: number;

    @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
    totalRevenue: number;
}