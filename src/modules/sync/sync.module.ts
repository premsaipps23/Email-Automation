import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncController } from './sync.controller';
import { MsIntegrationController } from './ms-integration.controller';
import { SystemSetting } from '../email/entities/system-setting.entity';
import { EmployeeModule } from '../employee/employee.module';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting]), EmployeeModule],
  controllers: [SyncController, MsIntegrationController],
})
export class SyncModule {}
