import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('email_logs')
export class EmailLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  employeeId: number;

  @Column()
  recipientEmail: string;

  @Column()
  subject: string;

  @Column()
  type: 'birthday' | 'anniversary';

  @Column({ default: 'sent' })
  status: 'sent' | 'failed';

  @Column({ nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  createdAt: Date;
}
