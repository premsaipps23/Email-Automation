import { Controller, Get, Param, Post, Body, UseGuards } from '@nestjs/common';
import { EmailService } from './email.service';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';

@Controller('emails')
@UseGuards(ClerkAuthGuard)
export class EmailController {
  constructor(private emailService: EmailService) {}

  @Get('logs')
  getEmailLogs() {
    return this.emailService.getEmailLogs();
  }

  @Get('logs/:employeeId')
  getEmployeeEmailLogs(@Param('employeeId') employeeId: string) {
    return this.emailService.getEmailLogs(+employeeId);
  }

  @Get('settings')
  getSettings() {
    return this.emailService.getAllSettings();
  }

  @Post('settings')
  updateSettings(@Body() settings: Record<string, string>) {
    return this.emailService.updateSettings(settings);
  }

  @Post('bulk-delete')
  removeMultiple(@Body('ids') ids: number[]) {
    return this.emailService.removeMultipleLogs(ids);
  }
}
