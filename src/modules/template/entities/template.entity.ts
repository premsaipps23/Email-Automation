import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('templates')
export class Template {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  type: 'birthday' | 'anniversary';

  @Column()
  subject: string;

  @Column('text')
  htmlContent: string;

  @Column({ nullable: true })
  textContent: string;

  @Column('json', { nullable: true })
  variables: string[];

  @Column({ nullable: true })
  imageUrl: string;

  @Column('json', { nullable: true })
  imageConfig: { x: number; y: number; width: number; height: number };

  @Column('json', { nullable: true })
  nameConfig: { x: number; y: number; fontSize: number; color: string };

  @Column({ nullable: true })
  greetingTemplate: string;

  @Column('json', { nullable: true })
  greetingConfig: { x: number; y: number; fontSize: number; color: string; width: number };

  @Column({ default: false })
  isDefault: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
