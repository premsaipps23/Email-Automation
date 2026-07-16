import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
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
  async triggerNow(@Body() body: { dry?: boolean; overrides?: Record<string, { ccList?: string[] }> } = {}) {
    return this.automationService.triggerNow(body.dry === true, body.overrides);
  }

  @Post('compose-send')
  async composeAndSend(
    @Body() body: { templateFile: string; photoFile: string; personName: string; recipientEmail: string; photoPlaceholder?: any; nameField?: any },
    @Req() req: any
  ) {
    const { templateFile, photoFile, personName, recipientEmail, photoPlaceholder, nameField } = body || {};
    if (!templateFile || !photoFile || !personName || !recipientEmail) {
      return { success: false, message: 'Missing required fields: templateFile, photoFile, personName, recipientEmail' };
    }

    const userEmail = req.user?.email;
    return this.automationService.composeAndSend(templateFile, photoFile, personName, recipientEmail, photoPlaceholder, nameField, userEmail);
  }

  @Post('preview')
  async previewCard(@Body() body: { templateFile?: string; photoFile?: string; personName?: string } = {}, @Req() req: any) {
    const { templateFile, photoFile, personName } = body || {};
    const userEmail = req.user?.email;
    return this.automationService.composePreview(templateFile, photoFile, personName, userEmail);
  }

  @Post('previews')
  async previewCards(@Req() req: any) {
    const userEmail = req.user?.email;
    return this.automationService.composeTodayPreviews(userEmail);
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
