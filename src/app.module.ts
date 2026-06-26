import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from 'pg';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { EmployeeModule } from './modules/employee/employee.module';
import { EmailModule } from './modules/email/email.module';
import { TemplateModule } from './modules/template/template.module';
import { AutomationModule } from './modules/automation/automation.module';
import { SyncModule } from './modules/sync/sync.module';
import { Employee } from './modules/employee/entities/employee.entity';
import { Template } from './modules/template/entities/template.entity';
import { EmailLog } from './modules/email/entities/email-log.entity';
import { SystemSetting } from './modules/email/entities/system-setting.entity';

@Module({
  imports: [
    ConfigModule.forRoot(),
    // Try Postgres (Neon) if DATABASE_URL is present and reachable; otherwise use SQLite for local dev
    TypeOrmModule.forRootAsync({
      useFactory: async () => {
        if (process.env.DATABASE_URL) {
          // quick connectivity check to avoid hard failures at startup
          try {
            const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
            await client.connect();
            await client.end();
            return {
              type: 'postgres',
              url: process.env.DATABASE_URL,
              entities: [Employee, Template, EmailLog, SystemSetting],
              synchronize: true,
              extra: { ssl: { rejectUnauthorized: false } },
            } as any;
          } catch (err) {
            console.error('Postgres connection test failed, falling back to SQLite:', err.message || err);
          }
        }
        return {
          type: 'sqlite',
          database: process.env.STORAGE_DIR ? require('path').join(process.env.STORAGE_DIR, 'hr-automation.db') : 'hr-automation.db',
          entities: [Employee, Template, EmailLog, SystemSetting],
          synchronize: true,
        } as any;
      },
    }),
    ScheduleModule.forRoot(),
    EmployeeModule,
    EmailModule,
    TemplateModule,
    AutomationModule,
    SyncModule,
  ],
})
export class AppModule {}
