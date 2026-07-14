import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { SystemSetting } from '../email/entities/system-setting.entity';

@Controller('api/integrations/microsoft')
export class MsIntegrationController {
  private settingsFilePath = path.join(process.cwd(), 'data', 'settings.json');

  constructor(
    @InjectRepository(SystemSetting)
    private settingsRepo: Repository<SystemSetting>,
  ) {}

  private async safeSaveSetting(key: string, value: string, userEmail?: string) {
    const finalKey = userEmail ? `${userEmail}:${key}` : key;
    try {
      await this.settingsRepo.save({ key: finalKey, value });
      return;
    } catch (err) {
      // fallback to file
    }
    try {
      const dir = path.dirname(this.settingsFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let obj: Record<string, any> = {};
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, 'utf8');
        obj = raw ? JSON.parse(raw) : {};
      }
      obj[finalKey] = value;
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      // ignore
    }
  }

  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    try {
      if (!code) return res.status(400).send('Missing code');

      // Decode state: supports both new base64 JSON format and legacy plain email format
      let userEmail = state;
      let frontendUrl = '';
      let callbackRedirectUri = process.env.MICROSOFT_REDIRECT_URI || process.env.MS_GRAPH_REDIRECT_URI || '';
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        if (decoded && typeof decoded === 'object') {
          userEmail = decoded.email || '';
          frontendUrl = decoded.frontendUrl || '';
          callbackRedirectUri = decoded.redirectUri || callbackRedirectUri;
        }
      } catch {
        // Legacy: state is just the plain email string
        userEmail = state;
      }

      if (userEmail) {
        await this.settingsRepo.save({ key: 'LAST_CONNECTED_USER_EMAIL', value: userEmail });
      }

      const clientId = process.env.MS_CLIENT_ID || process.env.MS_GRAPH_CLIENT_ID;
      const clientSecret = process.env.MS_CLIENT_SECRET || process.env.MS_GRAPH_CLIENT_SECRET;
      const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';

      if (!clientId || !clientSecret || !callbackRedirectUri) {
        return res.status(500).send('Microsoft client configuration missing on server.');
      }

      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('scope', 'offline_access Files.ReadWrite User.Read');
      params.append('code', code);
      params.append('redirect_uri', callbackRedirectUri);
      params.append('grant_type', 'authorization_code');
      params.append('client_secret', clientSecret);

      const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      const tokenResp = await axios.post(tokenUrl, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const data = tokenResp.data;
      if (data.access_token) await this.safeSaveSetting('MS_GRAPH_ACCESS_TOKEN', data.access_token, userEmail);
      if (data.refresh_token) await this.safeSaveSetting('MS_GRAPH_REFRESH_TOKEN', data.refresh_token, userEmail);
      if (data.expires_in) {
        const expiresAt = (Date.now() + data.expires_in * 1000).toString();
        await this.safeSaveSetting('MS_GRAPH_TOKEN_EXPIRES_AT', expiresAt, userEmail);
      }

      // Redirect back to the frontend using the URL decoded from state
      return res.redirect(`${frontendUrl}/?ms_connected=1`);
    } catch (err) {
      console.error('MS integration callback error', err?.message || err);
      return res.status(500).send('Failed to complete Microsoft OAuth: ' + (err?.message || err));
    }
  }
}
