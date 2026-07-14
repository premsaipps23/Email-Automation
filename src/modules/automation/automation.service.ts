import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronJob } from 'cron';
import { EmployeeService } from '../employee/employee.service';
import { EmailService } from '../email/email.service';
import { TemplateService } from '../template/template.service';
import { OpenRouterService } from './openrouter.service';
import { SystemSetting } from '../email/entities/system-setting.entity';
import * as path from 'path';
import * as fs from 'fs';

function getOrdinal(n: number) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

@Injectable()
export class AutomationService implements OnModuleInit {
  private readonly logger = new Logger(AutomationService.name);
  private automationEnabled = true;
  private readonly JOB_NAME = 'daily_email_automation';
  private readonly birthdayGreetingTemplate = 'Happy {AGE}{ORDINAL} Birthday!';
  private readonly anniversaryGreetingTemplate = 'Happy Work Anniversary';

  constructor(
    private employeeService: EmployeeService,
    private emailService: EmailService,
    private templateService: TemplateService,
    private openRouterService: OpenRouterService,
    private schedulerRegistry: SchedulerRegistry,
    @InjectRepository(SystemSetting)
    private settingsRepo: Repository<SystemSetting>,
  ) { }

  async onModuleInit() {
    const timeSetting = await this.settingsRepo.findOneBy({ key: 'AUTOMATION_TIME' });
    const time = timeSetting ? timeSetting.value : '21:25'; // Default
    await this.scheduleJob(time);
  }

  private async scheduleJob(time: string) {
    // Delete existing job if it exists
    try {
      this.schedulerRegistry.deleteCronJob(this.JOB_NAME);
    } catch (e) {
      // Job might not exist
    }

    const [hours, minutes] = time.split(':');
    const cronExpression = `0 ${minutes} ${hours} * * *`;

    const job = new CronJob(cronExpression, () => {
      this.handleDailyEmailAutomation();
    });

    this.schedulerRegistry.addCronJob(this.JOB_NAME, job);
    job.start();

    this.logger.log(`Scheduled daily automation at ${time} (Cron: ${cronExpression})`);
  }

  async updateSchedule(time: string) {
    await this.settingsRepo.save({ key: 'AUTOMATION_TIME', value: time });
    await this.scheduleJob(time);
    return { success: true, message: `Automation rescheduled to ${time}` };
  }

  async getSchedule() {
    const setting = await this.settingsRepo.findOneBy({ key: 'AUTOMATION_TIME' });
    return { time: setting ? setting.value : '21:25' };
  }

  async handleDailyEmailAutomation() {
    return this.handleDailyEmailAutomationInternal(false);
  }

  private async handleDailyEmailAutomationInternal(dryRun: boolean) {
    const summary = {
      total: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      details: [] as any[],
    };

    if (!this.automationEnabled) {
      this.logger.log('Automation is disabled, skipping...');
      return { success: false, message: 'Automation is disabled', ...summary };
    }
    this.logger.log('Starting daily email automation...');

    try {
      const todayEvents = await this.employeeService.getTodayEvents();
      summary.total = todayEvents.length;

      if (todayEvents.length === 0) {
        this.logger.log('No events found for today');
        return { success: true, message: 'No events found for today', ...summary };
      }

      this.logger.log(`Found ${todayEvents.length} events for today`);

      for (const event of todayEvents) {
        const result = await this.processEvent(event, dryRun);
        summary.details.push(result);
        if (result?.status === 'sent') summary.sent++;
        else if (result?.status === 'skipped') summary.skipped++;
        else summary.failed++;
      }

      this.logger.log('Daily email automation completed successfully');
    } catch (error) {
      this.logger.error('Error in daily email automation:', error);
      summary.failed++;
    }
    return { success: true, message: `Processed ${summary.total} events`, ...summary };
  }

  private async processEvent(event: any, dryRun = false) {
    try {
      if (!event.name || !event.name.trim()) {
        this.logger.warn(`Skipping event for employee ${event.employeeId}: missing name`);
        return { status: 'skipped', event, reason: 'Missing employee name' };
      }

      const template = await this.templateService.findByType(event.type);

      if (!template) {
        this.logger.error(`No template found for type: ${event.type}`);
        return { status: 'skipped', event, reason: `No template found for ${event.type}` };
      }

      const variables: Record<string, string> = {
        NAME: event.name,
      };

      if (event.type === 'birthday') {
        variables['AGE'] = event.age.toString();
      } else if (event.type === 'anniversary') {
        variables['YEARS'] = event.years.toString();
      }

      const renderedHtml = this.templateService.renderTemplate(template, variables);
      const subject = template.subject.replace(/{(\w+)}/g, (_, key) => variables[key] || '');

      let finalHtmlContent = renderedHtml;
      const attachments: any[] = [];

      const storageDir = process.env.STORAGE_DIR;
      if (storageDir) {
        try {
          const templatePath = this.templateService.getTemplatePath(template);
          const photoPath = event.photoUrl ? path.join(storageDir, event.photoUrl) : '';

          if (fs.existsSync(templatePath)) {
            // Prepare greeting text
            let greetingText = template.greetingTemplate || (event.type === 'birthday'
              ? this.birthdayGreetingTemplate
              : this.anniversaryGreetingTemplate);

            const gVars = {
              AGE: event.age?.toString() || '',
              YEARS: event.years?.toString() || '',
              ORDINAL: getOrdinal(event.type === 'birthday' ? event.age : event.years)
            };

            Object.entries(gVars).forEach(([key, val]) => {
              greetingText = greetingText.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
            });

            const bodyMessage = template
              ? this.templateService.renderTemplate(template, gVars)
              : '';

            // Generate the card directly from the OneDrive template file.
            const composedBuffer = await this.openRouterService.generateGreetingCard(
              templatePath,
              photoPath,
              event.name,
              greetingText,
              template.imageConfig,
              template.nameConfig,
              template.nameCoverConfig,
              template.greetingConfig,
              template.badgeConfig,
              event.type === 'anniversary' ? String(event.years || '').padStart(2, '0') : undefined,
              bodyMessage
            );

            attachments.push({
              filename: 'greeting-card.png',
              content: composedBuffer,
              cid: 'greeting_card',
              contentDisposition: 'inline'
            });

            finalHtmlContent = `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#ffffff;">
                <tr>
                  <td style="padding:0; margin:0;">
                    <img src="cid:greeting_card" alt="${event.type} card for ${event.name}" width="325" style="display:block; width:325px; max-width:325px; height:auto; border:0; outline:none; text-decoration:none;" />
                  </td>
                </tr>
                <tr>
                  <td style="padding-top:18px; font-family:Arial, sans-serif; font-size:12px; color:#333333;">
                    <p style="margin:0 0 18px;">Regards,</p>
                    <p style="margin:0;">TechGrit Team</p>
                  </td>
                </tr>
              </table>
            `;
          }
        } catch (err) {
          this.logger.error('Failed to generate greeting card image:', err);
          // Fallback to text-only email if image generation fails
        }
      }
      if (!event.photoUrl) {
        this.logger.warn(`Sending ${event.type} email for ${event.name} without profile photo.`);
      }

      // Get broadcast email(s) if configured; include as CC
      const broadcastEmail = await this.settingsRepo.findOneBy({ key: 'BROADCAST_EMAIL' });
      const recipients = [event.email];
      let ccList: string[] = [];
      if (broadcastEmail?.value) {
        ccList = broadcastEmail.value.split(',').map(s => s.trim()).filter(Boolean).filter(a => a !== event.email);
      }

      await this.emailService.sendEmail({
        to: recipients.join(', '),
        cc: ccList.length > 0 ? ccList : undefined,
        subject,
        htmlContent: finalHtmlContent,
        type: event.type,
        employeeId: event.employeeId,
        attachments: attachments.length > 0 ? attachments : undefined,
        dryRun,
      });

      this.logger.log(`Email sent to ${event.email} for ${event.type}`);
      return { status: 'sent', event };
    } catch (error) {
      this.logger.error(`Error processing event for ${event.email}:`, error);
      return { status: 'failed', event, reason: error.message || 'Failed to send email' };
    }
  }

  toggleAutomation(enabled: boolean) {
    this.automationEnabled = enabled;
    this.logger.log(`Automation ${enabled ? 'enabled' : 'disabled'}`);
  }

  getAutomationStatus() {
    return { enabled: this.automationEnabled };
  }

  async triggerNow(dry = false) {
    this.logger.log('Manual trigger started');
    const res = await this.handleDailyEmailAutomationInternal(dry);
    return { success: true, message: 'Automation triggered successfully', result: res };
  }

  async composeAndSend(templateFile: string, photoFile: string, personName: string, recipientEmail: string, photoPlaceholder?: any, nameField?: any, userEmail?: string) {
    try {
      const storageDir = process.env.STORAGE_DIR;
      if (!storageDir) throw new Error('STORAGE_DIR not defined');

      const allTemplates = this.templateService.findAll();
      const requestedTemplate = allTemplates.find(template => template.fileName === templateFile);
      const selectedTemplate: any = requestedTemplate || await this.templateService.findByType('birthday');
      const resolvedTemplatePath = this.templateService.getTemplatePath(selectedTemplate);
      const requestedTemplatePath = path.join(storageDir, 'templates', templateFile || '');
      const templatePath = fs.existsSync(requestedTemplatePath) ? requestedTemplatePath : resolvedTemplatePath;
      const photoPath = path.join(storageDir, photoFile);

      if (!fs.existsSync(templatePath) || !fs.existsSync(photoPath)) {
        return { success: false, message: 'Template or photo file not found in OneDrive directory' };
      }

      let yearsText = '02';
      let ageText = '25';
      try {
        const employees = await this.employeeService.findAll();
        const emp = employees.find(e => this.normalizeName(e.name) === this.normalizeName(personName));
        if (emp) {
          if (emp.doj) {
            const doj = new Date(emp.doj);
            if (!isNaN(doj.getTime())) {
              yearsText = String(new Date().getFullYear() - doj.getFullYear()).padStart(2, '0');
            }
          }
          if (emp.dob) {
            const dob = new Date(emp.dob);
            if (!isNaN(dob.getTime())) {
              ageText = String(new Date().getFullYear() - dob.getFullYear());
            }
          }
        }
      } catch (e) { }

      let greetingText = selectedTemplate?.greetingTemplate || (selectedTemplate?.type === 'anniversary'
        ? this.anniversaryGreetingTemplate
        : this.birthdayGreetingTemplate);

      const yearsInt = parseInt(yearsText) || 2;
      const ageInt = parseInt(ageText) || 25;

      const gVars = {
        AGE: ageText,
        YEARS: yearsText,
        ORDINAL: getOrdinal(selectedTemplate?.type === 'anniversary' ? yearsInt : ageInt)
      };

      Object.entries(gVars).forEach(([key, val]) => {
        greetingText = greetingText.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
      });

      const imageConfig = photoPlaceholder ? {
        x: photoPlaceholder.x,
        y: photoPlaceholder.y,
        width: photoPlaceholder.width,
        height: photoPlaceholder.height,
        shape: photoPlaceholder.shape || 'circle'
      } : undefined;

      const nameConfig = nameField ? {
        x: nameField.x,
        y: nameField.y,
        width: nameField.width,
        height: nameField.height
      } : undefined;

      const bodyMessage = selectedTemplate
        ? this.templateService.renderTemplate(selectedTemplate, gVars)
        : '';

      const buffer = await this.openRouterService.generateGreetingCard(
        templatePath,
        photoPath,
        personName,
        greetingText,
        imageConfig,
        nameConfig,
        selectedTemplate?.nameCoverConfig,
        undefined,
        selectedTemplate?.badgeConfig,
        selectedTemplate?.type === 'anniversary' ? yearsText : undefined,
        bodyMessage
      );

      // Generated card images are archived in generated templates.

      // Attempt to send via Microsoft Graph if tokens exist
      const accessToken = await this.emailService.getMicrosoftAccessToken(userEmail);
      if (accessToken) {
        try {
          // Prepare Graph send payload
          const base64Image = buffer.toString('base64');
          const subject = `A special greeting for ${personName}`;
          const htmlBody = `<div><p>Hi,</p><p>Please find attached a ${selectedTemplate?.type === 'anniversary' ? 'anniversary' : 'birthday'} card for ${personName}.</p></div>`;

          const graphPayload = {
            message: {
              subject,
              body: { contentType: 'HTML', content: htmlBody },
              toRecipients: [{ emailAddress: { address: recipientEmail } }],
              ccRecipients: [{ emailAddress: { address: 'all@techgrit.com' } }],
              attachments: [
                {
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  name: 'greeting-card.png',
                  contentBytes: base64Image
                }
              ]
            }
          };

          const axios = require('axios');
          await axios.post('https://graph.microsoft.com/v1.0/me/sendMail', graphPayload, { headers: { Authorization: `Bearer ${accessToken}` } });

          return { success: true, message: `Sent via Microsoft Graph to ${recipientEmail}` };
        } catch (err) {
          this.logger.error('Microsoft Graph send failed:', err.message || err);
          // fallback to draft archive
        }
      }

      // Try sending via configured SMTP (nodemailer) embedding image inline in the email body.
      try {
        const subject = `A special greeting for ${personName}`;
        const htmlBody = `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#ffffff;">
            <tr>
              <td style="padding:0; margin:0;">
                <img src="cid:greeting_card" alt="Greeting for ${personName}" width="325" style="display:block; width:325px; max-width:325px; height:auto; border:0; outline:none; text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding-top:18px; font-family:Arial, sans-serif; font-size:12px; color:#333333;">
                <p style="margin:0 0 18px;">Regards,</p>
                <p style="margin:0;">TechGrit Team</p>
              </td>
            </tr>
          </table>
        `;

        await this.emailService.sendEmail({
          to: recipientEmail,
          subject,
          htmlContent: htmlBody,
          type: selectedTemplate?.type === 'anniversary' ? 'anniversary' : 'birthday',
          employeeId: 0,
          attachments: [
            {
              filename: 'greeting-card.png',
              content: buffer,
              cid: 'greeting_card',
              contentDisposition: 'inline'
            }
          ],
          dryRun: false,
          userEmail,
        });

        return { success: true, message: `Sent via SMTP to ${recipientEmail}` };
      } catch (sendErr) {
        this.logger.error('SMTP send failed, archiving draft instead:', sendErr.message || sendErr);

        // Fallback: archive as draft (dryRun)
        await this.emailService.sendEmail({
          to: recipientEmail,
          subject: `Greeting for ${personName}`,
          htmlContent: `<p>Greeting card for ${personName} (archived draft).</p>`,
          type: selectedTemplate?.type === 'anniversary' ? 'anniversary' : 'birthday',
          employeeId: 0,
          dryRun: true,
          userEmail,
        });

        return { success: true, message: 'Draft archived (dry-run). Sending failed.' };
      }
    } catch (error) {
      this.logger.error('composeAndSend error:', error);
      return { success: false, message: error.message || 'Failed to compose/send' };
    }
  }

  /**
   * Find the most recent composed image in generated templates and return its filename and base64 content
   */
  async getLatestComposedImage() {
    try {
      const storageDir = process.env.STORAGE_DIR;
      if (!storageDir) throw new Error('STORAGE_DIR not defined');

      const generatedDir = path.join(storageDir, 'generated templates');
      if (!fs.existsSync(generatedDir)) {
        return { success: false, message: 'Generated templates folder not found', filename: null, contentBase64: null };
      }

      const entries = fs.readdirSync(generatedDir)
        .map((f: string) => ({ f, stat: fs.statSync(path.join(generatedDir, f)) }))
        .filter((e: any) => e.stat.isFile() && /\.png$/i.test(e.f))
        .sort((a: any, b: any) => b.stat.mtimeMs - a.stat.mtimeMs);

      if (!entries || entries.length === 0) {
        return { success: false, message: 'No composed images found', filename: null, contentBase64: null };
      }

      const latest = entries[0].f;
      const filePath = path.join(generatedDir, latest);
      const buf = fs.readFileSync(filePath);
      return { success: true, message: 'Found latest composed image', filename: latest, contentBase64: buf.toString('base64') };
    } catch (err) {
      this.logger.error('getLatestComposedImage error:', err);
      return { success: false, message: err.message || 'Error reading latest image', filename: null, contentBase64: null };
    }
  }

  /**
   * Generate a preview of the greeting card without sending any email.
   * Accepts template filename, photo filename, and person name.
   * Returns the composed card as base64.
   */
  async composePreview(templateFile?: string, photoFile?: string, personName?: string, userEmail?: string) {
    try {
      const storageDir = process.env.STORAGE_DIR;
      if (!storageDir) throw new Error('STORAGE_DIR not defined');

      const allTemplates = this.templateService.findAll();
      const templateFromFile = templateFile ? allTemplates.find(template => template.fileName === templateFile) : undefined;
      const template: any = templateFromFile || await this.templateService.findByType('birthday');
      const resolvedTemplatePath = this.templateService.getTemplatePath(template);
      const requestedTemplatePath = path.join(storageDir, 'templates', templateFile || '');
      const templatePath = fs.existsSync(requestedTemplatePath) ? requestedTemplatePath : resolvedTemplatePath;
      const previewPerson = await this.resolvePreviewPerson(photoFile, personName, userEmail);
      const photoPath = previewPerson.photoPath;

      if (!fs.existsSync(templatePath)) {
        return { success: false, message: `${template?.type || 'Template'} file not found in templates folder.` };
      }
      if (!fs.existsSync(photoPath)) {
        return { success: false, message: `No profile photo found in OneDrive profiles folder.` };
      }

      let greetingText = template?.greetingTemplate || (template?.type === 'anniversary'
        ? this.anniversaryGreetingTemplate
        : this.birthdayGreetingTemplate);

      const yearsInt = parseInt(String((previewPerson as any).years)) || 2;
      const ageInt = parseInt(String((previewPerson as any).age)) || 25;

      const gVars = {
        AGE: String(ageInt),
        YEARS: String(yearsInt).padStart(2, '0'),
        ORDINAL: getOrdinal(template?.type === 'anniversary' ? yearsInt : ageInt)
      };

      Object.entries(gVars).forEach(([key, val]) => {
        greetingText = greetingText.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
      });

      const bodyMessage = template
        ? this.templateService.renderTemplate(template, gVars)
        : '';

      const buffer = await this.openRouterService.generateGreetingCard(
        templatePath,
        photoPath,
        previewPerson.name,
        greetingText,
        template?.imageConfig,
        template?.nameConfig,
        template?.nameCoverConfig,
        template?.greetingConfig,
        template?.badgeConfig,
        template?.type === 'anniversary' ? String(yearsInt).padStart(2, '0') : undefined,
        bodyMessage
      );

      return {
        success: true,
        message: 'Preview generated',
        contentBase64: buffer.toString('base64'),
        templateFile: (template as any)?.fileName || path.basename(templatePath),
        photoFile: previewPerson.photoFile,
        personName: previewPerson.name,
      };
    } catch (error) {
      this.logger.error('composePreview error:', error);
      return { success: false, message: error.message || 'Failed to generate preview' };
    }
  }

  async composeTodayPreviews(userEmail?: string) {
    try {
      const storageDir = process.env.STORAGE_DIR;
      if (!storageDir) throw new Error('STORAGE_DIR not defined');

      const todayEvents = await this.employeeService.getTodayEvents(userEmail);
      const previews = [];

      for (const event of todayEvents) {
        const template = await this.templateService.findByType(event.type);
        const templatePath = this.templateService.getTemplatePath(template);
        if (!templatePath || !fs.existsSync(templatePath)) {
          previews.push({ success: false, event, message: `${event.type} template file not found.` });
          continue;
        }

        let greetingText = template.greetingTemplate || (event.type === 'birthday'
          ? this.birthdayGreetingTemplate
          : this.anniversaryGreetingTemplate);
        const gVars = {
          AGE: event.age?.toString() || '',
          YEARS: event.years?.toString() || '',
          ORDINAL: getOrdinal(event.type === 'birthday' ? event.age : event.years),
        };
        Object.entries(gVars).forEach(([key, val]) => {
          greetingText = greetingText.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
        });

        const bodyMessage = template
          ? this.templateService.renderTemplate(template, gVars)
          : '';

        const photoPath = event.photoUrl ? path.join(storageDir, event.photoUrl) : '';
        const buffer = await this.openRouterService.generateGreetingCard(
          templatePath,
          fs.existsSync(photoPath) ? photoPath : '',
          event.name,
          greetingText,
          template.imageConfig,
          template.nameConfig,
          template.nameCoverConfig,
          template.greetingConfig,
          template.badgeConfig,
          event.type === 'anniversary' ? String(event.years || '').padStart(2, '0') : undefined,
          bodyMessage
        );

        previews.push({
          success: true,
          event,
          templateFile: (template as any)?.fileName || path.basename(templatePath),
          photoFile: event.photoUrl || '',
          contentBase64: buffer.toString('base64'),
        });
      }

      return {
        success: true,
        total: todayEvents.length,
        previews,
      };
    } catch (error) {
      this.logger.error('composeTodayPreviews error:', error);
      return { success: false, message: error.message || 'Failed to generate previews', previews: [] };
    }
  }

  private async resolvePreviewPerson(photoFile?: string, personName?: string, userEmail?: string) {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) throw new Error('STORAGE_DIR not defined');

    if (photoFile) {
      const requested = path.join(storageDir, photoFile);
      if (fs.existsSync(requested)) {
        let years = 2; // Default fallback
        let age = 25;
        try {
          const nameToFind = personName || path.parse(photoFile).name;
          const employees = await this.employeeService.findAll(userEmail);
          const emp = employees.find(e => this.normalizeName(e.name) === this.normalizeName(nameToFind));
          if (emp) {
            if (emp.doj) {
              const doj = new Date(emp.doj);
              if (!isNaN(doj.getTime())) {
                years = new Date().getFullYear() - doj.getFullYear();
              }
            }
            if (emp.dob) {
              const dob = new Date(emp.dob);
              if (!isNaN(dob.getTime())) {
                age = new Date().getFullYear() - dob.getFullYear();
              }
            }
          }
        } catch (e) { }

        return {
          name: personName || path.parse(photoFile).name,
          photoFile,
          photoPath: requested,
          years,
          age,
        };
      }
    }

    const todayEvents = await this.employeeService.getTodayEvents(userEmail);
    const eventWithPhoto = todayEvents.find(event => event.photoUrl);
    if (eventWithPhoto) {
      return {
        name: personName || eventWithPhoto.name,
        photoFile: eventWithPhoto.photoUrl,
        photoPath: path.join(storageDir, eventWithPhoto.photoUrl),
        years: eventWithPhoto.years || 2,
        age: eventWithPhoto.age || 25,
      };
    }

    const profilesDir = path.join(storageDir, 'profiles');
    const firstProfile = fs.existsSync(profilesDir)
      ? fs.readdirSync(profilesDir).find(file => {
        const normalized = file.toLowerCase();
        return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file)
          && !normalized.includes('birthday')
          && !normalized.includes('anniv')
          && !normalized.includes('annivesary');
      })
      : '';

    let years = 2;
    let age = 25;
    if (firstProfile) {
      try {
        const empName = path.parse(firstProfile).name;
        const employees = await this.employeeService.findAll(userEmail);
        const emp = employees.find(e => this.normalizeName(e.name) === this.normalizeName(empName));
        if (emp) {
          if (emp.doj) {
            const doj = new Date(emp.doj);
            if (!isNaN(doj.getTime())) {
              years = new Date().getFullYear() - doj.getFullYear();
            }
          }
          if (emp.dob) {
            const dob = new Date(emp.dob);
            if (!isNaN(dob.getTime())) {
              age = new Date().getFullYear() - dob.getFullYear();
            }
          }
        }
      } catch (e) { }
    }

    return {
      name: personName || (firstProfile ? path.parse(firstProfile).name : 'Preview'),
      photoFile: firstProfile ? path.join('profiles', firstProfile) : '',
      photoPath: firstProfile ? path.join(profilesDir, firstProfile) : '',
      years,
      age,
    };
  }

  private normalizeName(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }
}
