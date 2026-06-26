import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';

@Controller('automation')
@UseGuards(ClerkAuthGuard)
export class AutomationController {
  constructor(private automationService: AutomationService) {}

  @Get('status')
  getStatus() {
    return this.automationService.getAutomationStatus();
  }

  @Post('toggle')
  toggleAutomation(@Body() body: { enabled: boolean }) {
    this.automationService.toggleAutomation(body.enabled);
    return { message: `Automation ${body.enabled ? 'enabled' : 'disabled'}` };
  }

  @Post('trigger')
  async triggerNow(@Body() body: { dry?: boolean } = {}) {
    return this.automationService.triggerNow(body.dry === true);
  }

  @Post('compose-send')
  async composeAndSend(@Body() body: { templateFile: string; photoFile: string; personName: string; recipientEmail: string; photoPlaceholder?: any; nameField?: any }) {
    const { templateFile, photoFile, personName, recipientEmail, photoPlaceholder, nameField } = body || {};
    if (!templateFile || !photoFile || !personName || !recipientEmail) {
      return { success: false, message: 'Missing required fields: templateFile, photoFile, personName, recipientEmail' };
    }

    return this.automationService.composeAndSend(templateFile, photoFile, personName, recipientEmail, photoPlaceholder, nameField);
  }

  @Post('preview')
  async previewCard(@Body() body: { templateFile?: string; photoFile?: string; personName?: string } = {}) {
    const { templateFile, photoFile, personName } = body || {};
    return this.automationService.composePreview(templateFile, photoFile, personName);
  }

  @Post('previews')
  async previewCards() {
    return this.automationService.composeTodayPreviews();
  }

  @Get('preview-last')
  async previewLast() {
    return this.automationService.getLatestComposedImage();
  }

  @Get('schedule')
  getSchedule() {
    return this.automationService.getSchedule();
  }

  @Post('schedule')
  updateSchedule(@Body() body: { time: string }) {
    return this.automationService.updateSchedule(body.time);
  }
}
