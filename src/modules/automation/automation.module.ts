import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { OpenRouterService } from './openrouter.service';
import { EmployeeModule } from '../employee/employee.module';
import { EmailModule } from '../email/email.module';
import { TemplateModule } from '../template/template.module';
import { SystemSetting } from '../email/entities/system-setting.entity';

@Module({
  imports: [
    EmployeeModule, 
    EmailModule, 
    TemplateModule,
    TypeOrmModule.forFeature([SystemSetting])
  ],
  providers: [AutomationService, OpenRouterService],
  controllers: [AutomationController],
})
export class AutomationModule {}
