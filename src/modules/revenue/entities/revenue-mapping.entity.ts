import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('revenue_mappings')
export class RevenueMapping {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    pageId: string; // Meta Graph API Page ID

    @Column()
    pageName: string;

    @Column({ nullable: true })
    team: string; // e.g., "Design Team"

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}