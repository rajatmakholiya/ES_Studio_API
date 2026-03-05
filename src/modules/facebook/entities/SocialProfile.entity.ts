import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('social_profiles')
export class SocialProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  profileId: string;

  @Column()
  name: string;

  @Column()
  platform: string;

  @Column()
  accessToken: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 'COMPLETED' })
  syncState: string;

  @Column({ type: 'text', nullable: true })
  lastSyncError: string;
}
