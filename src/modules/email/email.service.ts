import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { EmailLog } from './entities/email-log.entity';
import { SystemSetting } from './entities/system-setting.entity';

interface SendEmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  type: 'birthday' | 'anniversary';
  employeeId: number;
  attachments?: any[];
  cc?: string[];
  dryRun?: boolean;
}

@Injectable()
export class EmailService {
  constructor(
    @InjectRepository(EmailLog)
    private emailLogRepo: Repository<EmailLog>,
    @InjectRepository(SystemSetting)
    private settingsRepo: Repository<SystemSetting>,
  ) {}

  private async getSetting(key: string, defaultValue: string): Promise<string> {
    const setting = await this.settingsRepo.findOneBy({ key });
    return setting ? setting.value : defaultValue;
  }

  async getAllSettings() {
    const settings = await this.settingsRepo.find();
    const result: Record<string, string> = {
      EMAIL_USER: '',
      EMAIL_PASSWORD: '', // Hide password
      EMAIL_FROM: 'hr@company.com',
    };

    settings.forEach(s => {
      result[s.key] = s.value;
    });

    // Prefer live environment values so the UI reflects the credentials actually used for SMTP.
    if (process.env.EMAIL_USER) result.EMAIL_USER = process.env.EMAIL_USER;
    if (process.env.EMAIL_FROM) result.EMAIL_FROM = process.env.EMAIL_FROM;

    return result;
  }

  async updateSettings(settings: Record<string, string>) {
    for (const [key, value] of Object.entries(settings)) {
      // Don't overwrite password with empty string if user didn't provide one (due to UI masking)
      if (key === 'EMAIL_PASSWORD' && !value) {
        continue;
      }
      await this.settingsRepo.save({ key, value });
    }
    return { success: true };
  }

  private async createTransporter() {
    const user = (process.env.EMAIL_USER || await this.getSetting('EMAIL_USER', '')).trim();
    // Gmail app passwords are often displayed with spaces; strip them before auth.
    const pass = (process.env.EMAIL_PASSWORD || await this.getSetting('EMAIL_PASSWORD', '')).replace(/\s+/g, '');

    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
  }

  private async getMicrosoftAccessToken() {
    const tokenSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_ACCESS_TOKEN' });
    const refreshSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_REFRESH_TOKEN' });
    const expiresSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_TOKEN_EXPIRES_AT' });

    let accessToken = (tokenSetting?.value || process.env.MS_GRAPH_ACCESS_TOKEN || '').trim();
    const refreshToken = (refreshSetting?.value || process.env.MS_GRAPH_REFRESH_TOKEN || '').trim();
    const expiresAt = expiresSetting ? parseInt(expiresSetting.value, 10) : 0;
    const now = Date.now();

    if (accessToken && (!expiresAt || expiresAt - 60000 > now)) {
      return accessToken;
    }

    if (!refreshToken) {
      return accessToken || null;
    }

    const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
    const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';

    if (!clientId || !clientSecret) {
      return accessToken || null;
    }

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_secret', clientSecret);
    params.append('scope', 'offline_access Files.ReadWrite User.Read');

    const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const tokenResp = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = tokenResp.data || {};

    if (data.access_token) {
      accessToken = data.access_token;
      await this.settingsRepo.save({ key: 'MS_GRAPH_ACCESS_TOKEN', value: data.access_token });
    }
    if (data.refresh_token) {
      await this.settingsRepo.save({ key: 'MS_GRAPH_REFRESH_TOKEN', value: data.refresh_token });
    }
    if (data.expires_in) {
      await this.settingsRepo.save({ key: 'MS_GRAPH_TOKEN_EXPIRES_AT', value: String(Date.now() + data.expires_in * 1000) });
    }

    return accessToken || null;
  }

  private async sendViaMicrosoftGraph(options: SendEmailOptions, from: string) {
    const accessToken = await this.getMicrosoftAccessToken();
    if (!accessToken) {
      return { success: false, message: 'Microsoft Graph is not configured' };
    }

    const attachments = options.attachments?.map(attachment => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: attachment.filename || attachment.name || 'attachment',
      contentType: attachment.contentType || (attachment.cid ? 'image/png' : 'application/octet-stream'),
      contentBytes: Buffer.isBuffer(attachment.content)
        ? attachment.content.toString('base64')
        : (attachment.content ? Buffer.from(attachment.content).toString('base64') : ''),
      isInline: attachment.contentDisposition === 'inline' || !!attachment.cid,
      contentId: attachment.cid,
    })) || [];

    const payload = {
      message: {
        subject: options.subject,
        body: { contentType: 'HTML', content: options.htmlContent },
        toRecipients: options.to.split(',').map(email => ({ emailAddress: { address: email.trim() } })).filter(item => item.emailAddress.address),
        ccRecipients: options.cc?.map(email => ({ emailAddress: { address: email } })) || [],
        attachments,
      },
      saveToSentItems: true,
    };

    await axios.post('https://graph.microsoft.com/v1.0/me/sendMail', payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });

    await this.emailLogRepo.save({
      employeeId: options.employeeId,
      recipientEmail: options.to,
      subject: options.subject,
      type: options.type,
      status: 'sent',
    });

    return { success: true, message: 'Email sent successfully via Microsoft Graph' };
  }

  async sendEmail(options: SendEmailOptions) {
    try {
      const from = (process.env.EMAIL_FROM || await this.getSetting('EMAIL_FROM', 'hr@company.com')).trim();

      // Dry-run mode: explicit `options.dryRun` overrides env; otherwise fall back to env
      const isDry = (typeof options.dryRun === 'boolean') ? options.dryRun : (process.env.EMAIL_DRY_RUN === 'true');
      if (isDry) {
        try {
          const storageDir = process.env.STORAGE_DIR;
          if (!storageDir) throw new Error('STORAGE_DIR not defined');

          const archiveDir = path.join(storageDir, 'processed', 'email-drafts');
          if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
          const timestamp = Date.now();
          const fileName = `email_draft_${options.employeeId}_${timestamp}.json`;
          const payload = {
            from,
            to: options.to,
            cc: options.cc,
            subject: options.subject,
            html: options.htmlContent,
            attachments: options.attachments?.map(a => ({ filename: a.filename, cid: a.cid })) || [],
          };
          fs.writeFileSync(path.join(archiveDir, fileName), JSON.stringify(payload, null, 2));
        } catch (archErr) {
          // ignore archival errors but log
          console.error('Failed to archive draft email:', archErr.message);
        }

        await this.emailLogRepo.save({
          employeeId: options.employeeId,
          recipientEmail: options.to,
          subject: options.subject,
          type: options.type,
          status: 'sent',
        });

        return { success: true, message: 'Dry-run: email archived locally' };
      }

      try {
        return await this.sendViaMicrosoftGraph(options, from);
      } catch (graphError) {
        const message = graphError?.message || String(graphError);
        console.warn('Microsoft Graph send failed, falling back to SMTP:', message);
      }

      const transporter = await this.createTransporter();
      const attachments = options.attachments?.map(attachment => ({
        ...attachment,
        contentType: attachment.contentType || (attachment.cid ? 'image/png' : undefined),
        contentDisposition: attachment.contentDisposition || (attachment.cid ? 'inline' : undefined),
      }));

      await transporter.sendMail({
        from,
        to: options.to,
        cc: options.cc && options.cc.length > 0 ? options.cc.join(',') : undefined,
        subject: options.subject,
        html: options.htmlContent,
        attachDataUrls: true,
        attachments,
      });

      await this.emailLogRepo.save({
        employeeId: options.employeeId,
        recipientEmail: options.to,
        subject: options.subject,
        type: options.type,
        status: 'sent',
      });

      return { success: true, message: 'Email sent successfully' };
    } catch (error) {
      await this.emailLogRepo.save({
        employeeId: options.employeeId,
        recipientEmail: options.to,
        subject: options.subject,
        type: options.type,
        status: 'failed',
        errorMessage: error.message,
      });

      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  async getEmailLogs(employeeId?: number) {
    if (employeeId) {
      return this.emailLogRepo.findBy({ employeeId });
    }
    return this.emailLogRepo.find();
  }

  async removeMultipleLogs(ids: number[]) {
    return this.emailLogRepo.delete(ids);
  }
}
