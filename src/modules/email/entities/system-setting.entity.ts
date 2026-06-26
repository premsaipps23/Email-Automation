import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity()
export class SystemSetting {
  @PrimaryColumn()
  key: string;

  @Column()
  value: string;
}
