
import { Controller, Post, Res, Body, Get, Query, UseInterceptors, UploadedFile, UseGuards, Req } from '@nestjs/common';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';
import { Response } from 'express';
import axios from 'axios';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { SystemSetting } from '../email/entities/system-setting.entity';
import { EmployeeService } from '../employee/employee.service';

@Controller('sync')
export class SyncController {
  private readonly hrFolderName = 'HR Email Automation';
  constructor(
    private employeeService: EmployeeService,
    @InjectRepository(SystemSetting)
    private settingsRepo: Repository<SystemSetting>,
  ) {}

  // Safe setting helpers: try DB first, fallback to local JSON file when DB unavailable
  private settingsFilePath = path.join(process.cwd(), 'data', 'settings.json');

  private async safeGetSetting(key: string, userEmail?: string): Promise<string | null> {
    let email = userEmail;
    if (!email) {
      const lastConnected = await this.settingsRepo.findOneBy({ key: 'LAST_CONNECTED_USER_EMAIL' });
      email = lastConnected?.value || undefined;
    }
    const finalKey = email ? `${email}:${key}` : key;
    try {
      const s = await this.settingsRepo.findOneBy({ key: finalKey });
      if (s) return s.value;
    } catch (err) {
      // fall through to file fallback
    }
    try {
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, 'utf8');
        const obj = JSON.parse(raw || '{}');
        return obj[finalKey] || null;
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  private async safeSaveSetting(key: string, value: string, userEmail?: string) {
    let email = userEmail;
    if (!email) {
      const lastConnected = await this.settingsRepo.findOneBy({ key: 'LAST_CONNECTED_USER_EMAIL' });
      email = lastConnected?.value || undefined;
    }
    const finalKey = email ? `${email}:${key}` : key;
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

  private async getGraphItems(url: string, accessToken: string) {
    const items: any[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      const resp = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const values = Array.isArray(resp.data?.value) ? resp.data.value : [];
      items.push(...values);
      nextUrl = resp.data?.['@odata.nextLink'] || null;
    }

    return items;
  }

  private async getFreshGraphAccessToken(userEmail?: string): Promise<string | null> {
    let email = userEmail;
    if (!email) {
      const lastConnected = await this.settingsRepo.findOneBy({ key: 'LAST_CONNECTED_USER_EMAIL' });
      email = lastConnected?.value || undefined;
    }

    const accessTokenVal = await this.safeGetSetting('MS_GRAPH_ACCESS_TOKEN', email);
    const refreshTokenVal = await this.safeGetSetting('MS_GRAPH_REFRESH_TOKEN', email);
    const expiresAtVal = await this.safeGetSetting('MS_GRAPH_TOKEN_EXPIRES_AT', email);

    let accessToken = accessTokenVal || process.env.MS_GRAPH_ACCESS_TOKEN || null;
    const refreshToken = refreshTokenVal || process.env.MS_GRAPH_REFRESH_TOKEN || null;
    const expiresAt = expiresAtVal ? parseInt(expiresAtVal, 10) : 0;
    const now = Date.now();

    if (accessToken && expiresAt && expiresAt - 60000 > now) {
      return accessToken;
    }

    if (!refreshToken) {
      return accessToken || null;
    }

    const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
    const tenant = (await this.safeGetSetting('MS_TENANT_ID', email)) || process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';

    if (!clientId || !clientSecret) {
      return accessToken || null;
    }

    try {
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
        await this.safeSaveSetting('MS_GRAPH_ACCESS_TOKEN', data.access_token, email);
      }
      if (data.refresh_token) {
        await this.safeSaveSetting('MS_GRAPH_REFRESH_TOKEN', data.refresh_token, email);
      }
      if (data.expires_in) {
        await this.safeSaveSetting('MS_GRAPH_TOKEN_EXPIRES_AT', String(Date.now() + data.expires_in * 1000), email);
      }
      return accessToken;
    } catch (err) {
      console.error('Token refresh failed:', err?.message || err);
      return accessToken || null;
    }
  }

  private isExcelFile(name?: string) {
    return typeof name === 'string' && /\.(xlsx|xls)$/i.test(name);
  }

  private isImageFile(name?: string) {
    return typeof name === 'string' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  }

  private normalizeName(value: string) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private inferTemplateType(fileName?: string) {
    const normalized = String(fileName || '').toLowerCase();
    if (normalized.includes('birthday') || normalized.includes('bday') || normalized.includes('birth')) {
      return 'birthday';
    }
    if (normalized.includes('anniversary') || normalized.includes('annivesary') || normalized.includes('anniv')) {
      return 'anniversary';
    }
    return 'general';
  }

  private dedupeTemplateFiles(items: any[]) {
    const seen = new Set<string>();
    const result: any[] = [];

    for (const item of items) {
      const type = this.inferTemplateType(item?.name);
      const key = type === 'general' ? `file:${String(item?.name || '').toLowerCase()}` : `type:${type}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(item);
    }

    return result;
  }

  private async resolveOneDriveFolderId(accessToken: string, userEmail?: string, forceRefresh = false) {
    if (!accessToken) {
      return null;
    }

    if (!forceRefresh) {
      const storedFolderId = await this.safeGetSetting('SYNC_ONEDRIVE_FOLDER_ID', userEmail);
      if (storedFolderId) {
        return storedFolderId;
      }
    }

    const configuredFolderName = (await this.safeGetSetting('SYNC_ONEDRIVE_FOLDER_NAME', userEmail)) || this.hrFolderName;
    const searchUrl = `https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(configuredFolderName)}')?$select=id,name,folder,parentReference,webUrl`;
    const searchItems = await this.getGraphItems(searchUrl, accessToken);
    const exactMatch = searchItems.find(item => item?.folder && this.normalizeName(item.name) === this.normalizeName(configuredFolderName));
    if (exactMatch?.id) {
      await this.safeSaveSetting('SYNC_ONEDRIVE_FOLDER_ID', exactMatch.id, userEmail);
      return exactMatch.id;
    }

    const fallback = searchItems.find(item => item?.folder) || null;
    if (fallback?.id) {
      await this.safeSaveSetting('SYNC_ONEDRIVE_FOLDER_ID', fallback.id, userEmail);
      return fallback.id;
    }

    try {
      const rootChildren = await this.getGraphItems(
        'https://graph.microsoft.com/v1.0/me/drive/root/children?$select=id,name,folder,parentReference,webUrl',
        accessToken,
      );
      const rootFolder = rootChildren.find(item => item?.folder && this.normalizeName(item.name) === this.normalizeName(configuredFolderName));
      if (rootFolder?.id) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_FOLDER_ID', rootFolder.id, userEmail);
        return rootFolder.id;
      }
    } catch (err) {
      // ignore and fall through
    }

    return null;
  }

  private async walkFolderTree(folderId: string, accessToken: string, currentPath = ''): Promise<any[]> {
    const children = await this.getGraphItems(
      `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}/children?$select=id,name,size,webUrl,parentReference,file,folder,lastModifiedDateTime`,
      accessToken,
    );

    const results: any[] = [];
    for (const child of children) {
      const childPath = currentPath ? `${currentPath}/${child.name}` : child.name;
      if (child?.folder) {
        const nested = await this.walkFolderTree(child.id, accessToken, childPath);
        results.push(...nested);
      } else {
        results.push({ ...child, folderPath: currentPath });
      }
    }
    return results;
  }

  private async syncProfileImages(folderItems: any[], accessToken: string) {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) return;

    const profilesDir = path.join(storageDir, 'profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }

    const imageItems = folderItems.filter(item => this.isImageFile(item?.name));
    for (const item of imageItems) {
      try {
        const resp = await axios.get(
          `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(item.id)}/content`,
          {
            responseType: 'arraybuffer',
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );

        const buffer = Buffer.from(resp.data);
        const targetName = item.name;
        const targetPath = path.join(profilesDir, targetName);
        fs.writeFileSync(targetPath, buffer);
      } catch (err) {
        const e = err as any;
        console.error(`Failed to sync profile image ${item?.name}:`, e?.message || e);
      }
    }
  }

  private async syncTemplateFiles(folderItems: any[], accessToken: string) {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) return;

    const templatesDir = path.join(storageDir, 'templates');
    if (!fs.existsSync(templatesDir)) {
      fs.mkdirSync(templatesDir, { recursive: true });
    }

    const templateItems = folderItems.filter(item => {
      const folderPath = String(item?.folderPath || '').toLowerCase();
      return folderPath.startsWith('templates') && this.isImageFile(item?.name);
    });

    for (const item of templateItems) {
      try {
        const resp = await axios.get(
          `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(item.id)}/content`,
          {
            responseType: 'arraybuffer',
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );

        const buffer = Buffer.from(resp.data);
        const targetPath = path.join(templatesDir, item.name);
        fs.writeFileSync(targetPath, buffer);
      } catch (err) {
        const e = err as any;
        console.error(`Failed to sync template file ${item?.name}:`, e?.message || e);
      }
    }
  }

  private async persistSyncWorkbook(buffer: Buffer, fileName: string, userEmail?: string) {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) return null;

    const syncDir = path.join(storageDir, 'sync');
    if (!fs.existsSync(syncDir)) {
      fs.mkdirSync(syncDir, { recursive: true });
    }

    const suffix = userEmail ? `_${userEmail}` : '';
    const safeName = fileName && /\.(xlsx|xls)$/i.test(fileName) ? `${path.parse(fileName).name}${suffix}${path.extname(fileName)}` : `selected_sync${suffix}.xlsx`;
    const targetPath = path.join(syncDir, safeName);
    fs.writeFileSync(targetPath, buffer);
    await this.safeSaveSetting('SYNC_FILE_PATH', targetPath, userEmail);
    return targetPath;
  }

  @Post('run')
  @UseGuards(ClerkAuthGuard)
  async runSync(@Res() res: Response, @Req() req?: any) {
    try {
      const userEmail = req?.user?.email;
      const setting = await this.settingsRepo.findOneBy({ key: userEmail ? `${userEmail}:SYNC_FILE_PATH` : 'SYNC_FILE_PATH' });
      const filePath = setting ? setting.value : process.env.EXCEL_FILE_PATH;

      if (!filePath) {
        return res.status(400).json({ success: false, message: 'No sync file configured (SYNC_FILE_PATH or EXCEL_FILE_PATH).' });
      }

      if (!fs.existsSync(filePath)) {
        return res.status(400).json({ success: false, message: `Configured file does not exist: ${filePath}` });
      }

      const buffer = fs.readFileSync(filePath);
      const fakeFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: path.basename(filePath),
        encoding: '7bit',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buffer.length,
        buffer,
        destination: '',
        filename: '',
        path: filePath,
      } as any;

      const result = await this.employeeService.processExcel(fakeFile, userEmail);
      // Refresh events is handled on client; respond with result
      return res.json({ success: true, result });
    } catch (error) {
      // Improve error messaging for common DB/connectivity issues
      const e = error as any;
      const msg = e?.message || String(error);
      if (msg.includes('password authentication failed') || msg.includes('role') && msg.includes('does not exist')) {
        return res.status(500).json({
          success: false,
          message: 'Database authentication failed. Check your DATABASE_URL/DB credentials (Neon/Postgres). ' + msg,
        });
      }
      if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        return res.status(500).json({ success: false, message: 'Database host not found: check DATABASE_URL host and network connectivity. ' + msg });
      }
      return res.status(500).json({ success: false, message: msg });
    }
  }

  @Post('onedrive/auth')
  @UseGuards(ClerkAuthGuard)
  async saveOneDriveToken(@Req() req: any, @Body() body: { accessToken?: string; refreshToken?: string; code?: string; path?: string; folderId?: string; redirectUri?: string; clientId?: string; clientSecret?: string }, @Res() res: Response) {
    try {
      const userEmail = req.user?.email;
      if (userEmail) {
        await this.settingsRepo.save({ key: 'LAST_CONNECTED_USER_EMAIL', value: userEmail });
      }

      // simple token save
      if (body.accessToken) {
        await this.safeSaveSetting('MS_GRAPH_ACCESS_TOKEN', body.accessToken, userEmail);
      }
      if (body.refreshToken) {
        await this.safeSaveSetting('MS_GRAPH_REFRESH_TOKEN', body.refreshToken, userEmail);
      }
      if (body.path) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_PATH', body.path, userEmail);
      }
      if (body.folderId) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_FOLDER_ID', body.folderId, userEmail);
      }
      if ((body as any).itemId) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_ITEM_ID', (body as any).itemId, userEmail);
      }

      // If an authorization code is provided, exchange it for tokens
      if (body.code) {
        // support multiple env names and body overrides
        const clientId = body.clientId || process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
        const clientSecret = body.clientSecret || process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
        const redirectUri = body.redirectUri || process.env.MS_GRAPH_REDIRECT_URI || process.env.MICROSOFT_REDIRECT_URI;
        if (!clientId || !clientSecret || !redirectUri) {
          return res.status(400).json({ success: false, message: 'Missing clientId/clientSecret/redirectUri for code exchange.' });
        }

        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('scope', 'offline_access Files.ReadWrite User.Read');
        params.append('code', body.code);
        params.append('redirect_uri', redirectUri);
        params.append('grant_type', 'authorization_code');
        params.append('client_secret', clientSecret);

        const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';
        const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
        const tokenResp = await axios.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const data = tokenResp.data;
        if (data.access_token) {
          await this.safeSaveSetting('MS_GRAPH_ACCESS_TOKEN', data.access_token, userEmail);
        }
        if (data.refresh_token) {
          await this.safeSaveSetting('MS_GRAPH_REFRESH_TOKEN', data.refresh_token, userEmail);
        }
        if (data.expires_in) {
          const expiresAt = (Date.now() + data.expires_in * 1000).toString();
          await this.safeSaveSetting('MS_GRAPH_TOKEN_EXPIRES_AT', expiresAt, userEmail);
        }
      }

      return res.json({ success: true });
    } catch (error) {
      const e = error as any;
      return res.status(500).json({ success: false, message: e?.message || String(error) });
    }
  }

  // Returns an authorization URL the user can visit to consent
  @Get('onedrive/start')
  @UseGuards(ClerkAuthGuard)
  async getOneDriveAuthUrl(@Req() req: any, @Query('redirectUri') redirectUri?: string, @Res() res?: Response) {
    try {
      // support multiple env names for compatibility
      const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
      const redirect = redirectUri || process.env.MS_GRAPH_REDIRECT_URI || process.env.MICROSOFT_REDIRECT_URI;
      if (!clientId || !redirect) {
        return res ? res.status(400).json({ success: false, message: 'MS_GRAPH_CLIENT_ID or MS_GRAPH_REDIRECT_URI not configured.' }) : { success: false };
      }
      const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirect,
        response_mode: 'query',
        scope: 'offline_access Files.ReadWrite User.Read',
        state: req.user?.email || '',
      });
      const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
      return res ? res.json({ success: true, url }) : { success: true, url };
    } catch (error) {
      const e = error as any;
      return res.status(500).json({ success: false, message: e?.message || String(error) });
    }
  }

  // List excel files in the user's OneDrive (requires tokens)
  @Get('onedrive/list')
  @UseGuards(ClerkAuthGuard)
  async listOneDriveFiles(@Req() req: any, @Res() res: Response) {
    try {
      const userEmail = req.user?.email;
      const accessToken = await this.getFreshGraphAccessToken(userEmail);
      if (!accessToken) {
        return res.status(400).json({ success: false, message: 'No valid MS Graph access token available.' });
      }

      const folderId = await this.resolveOneDriveFolderId(accessToken, userEmail);
      if (!folderId) {
        return res.status(400).json({ success: false, message: `Could not find the "${this.hrFolderName}" folder in OneDrive.` });
      }

      const allItems = await this.walkFolderTree(folderId, accessToken);
      const combined = allItems
        .filter((it: any) => this.isExcelFile(it?.name))
        .map((it: any) => ({
          id: it.id,
          name: it.name,
          webUrl: it.webUrl,
          parentPath: it.folderPath || it.parentReference?.path,
        }));

      const templateFiles = allItems
        .filter((it: any) => this.isImageFile(it?.name) && String(it?.folderPath || '').toLowerCase().startsWith('templates'))
        .sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || '')))
        .map((it: any) => ({
          id: it.id,
          name: it.name,
          webUrl: it.webUrl,
          parentPath: it.folderPath || it.parentReference?.path,
        }));

      return res.json({ success: true, files: combined, templateFiles: this.dedupeTemplateFiles(templateFiles), folderId, folderName: this.hrFolderName });
    } catch (err) {
      const e = err as any;
      return res.status(500).json({ success: false, message: e?.message || String(err) });
    }
  }

  @Post('onedrive/run')
  @UseGuards(ClerkAuthGuard)
  async runOneDriveSync(@Res() res: Response, @Req() req?: any) {
    try {
      const userEmail = req?.user?.email;
      const accessToken = await this.getFreshGraphAccessToken(userEmail);
      if (!accessToken) {
        return res.status(400).json({ success: false, message: 'No valid MS Graph access token available.' });
      }

      const pathSetting = await this.settingsRepo.findOneBy({ key: userEmail ? `${userEmail}:SYNC_ONEDRIVE_PATH` : 'SYNC_ONEDRIVE_PATH' });
      const folderIdSetting = await this.settingsRepo.findOneBy({ key: userEmail ? `${userEmail}:SYNC_ONEDRIVE_FOLDER_ID` : 'SYNC_ONEDRIVE_FOLDER_ID' });
      const remotePath = pathSetting ? pathSetting.value : process.env.SYNC_ONEDRIVE_PATH;
      const itemIdSetting = await this.settingsRepo.findOneBy({ key: userEmail ? `${userEmail}:SYNC_ONEDRIVE_ITEM_ID` : 'SYNC_ONEDRIVE_ITEM_ID' });
      const remoteItemId = itemIdSetting ? itemIdSetting.value : process.env.SYNC_ONEDRIVE_ITEM_ID;
      const remoteFolderId = folderIdSetting ? folderIdSetting.value : await this.resolveOneDriveFolderId(accessToken, userEmail);

      if (!remotePath && !remoteItemId && !remoteFolderId) return res.status(400).json({ success: false, message: `No OneDrive folder configured. Expected "${this.hrFolderName}".` });

      if (!remoteFolderId) {
        return res.status(400).json({ success: false, message: `Could not resolve the "${this.hrFolderName}" folder in OneDrive.` });
      }

      let currentFolderId = remoteFolderId;
      let folderItems = await this.walkFolderTree(currentFolderId, accessToken);
      let excelItems = folderItems.filter((item: any) => this.isExcelFile(item?.name));

      if (excelItems.length === 0) {
        const freshFolderId = await this.resolveOneDriveFolderId(accessToken, userEmail, true);
        if (freshFolderId && freshFolderId !== currentFolderId) {
          currentFolderId = freshFolderId;
          folderItems = await this.walkFolderTree(currentFolderId, accessToken);
          excelItems = folderItems.filter((item: any) => this.isExcelFile(item?.name));
        }
      }

      let selectedExcel = remoteItemId
        ? folderItems.find((item: any) => item.id === remoteItemId && this.isExcelFile(item?.name))
        : null;

      if (!selectedExcel) {
        selectedExcel = excelItems[0];
      }

      if (!selectedExcel) {
        return res.status(400).json({ success: false, message: `No Excel file found inside the "${this.hrFolderName}" folder.` });
      }

      // Save item ID and folder ID to settings so write-back is aware of it
      if (selectedExcel?.id) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_ITEM_ID', selectedExcel.id, userEmail);
      }
      if (remoteFolderId) {
        await this.safeSaveSetting('SYNC_ONEDRIVE_FOLDER_ID', remoteFolderId, userEmail);
      }

      // Determine local target path
      const storageDir = process.env.STORAGE_DIR;
      let targetPath = '';
      if (storageDir) {
        const syncDir = path.join(storageDir, 'sync');
        const suffix = userEmail ? `_${userEmail}` : '';
        const safeName = selectedExcel.name && /\.(xlsx|xls)$/i.test(selectedExcel.name) ? `${path.parse(selectedExcel.name).name}${suffix}${path.extname(selectedExcel.name)}` : `selected_sync${suffix}.xlsx`;
        targetPath = path.join(syncDir, safeName);
      }

      // Check if local file exists and is newer than the remote file on OneDrive
      let buffer = null;
      let isLocalNewer = false;
      const localPath = await this.employeeService.resolveWorkbookPath(userEmail);

      if (localPath && fs.existsSync(localPath)) {
        const localStat = fs.statSync(localPath);
        const remoteModifiedTime = selectedExcel.lastModifiedDateTime ? new Date(selectedExcel.lastModifiedDateTime) : new Date(0);
        if (localStat.mtime > remoteModifiedTime) {
          isLocalNewer = true;
          buffer = fs.readFileSync(localPath);
        }
      }

      if (!isLocalNewer) {
        // Microsoft Graph download endpoint for the selected Excel file
        const urlById = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(selectedExcel.id)}/content`;
        const resp = await axios.get(urlById, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${accessToken}` } });
        buffer = Buffer.from(resp.data);

        // Save downloaded file to the local target path before running processExcel
        if (targetPath && buffer) {
          const targetDir = path.dirname(targetPath);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          fs.writeFileSync(targetPath, buffer);
          await this.safeSaveSetting('SYNC_FILE_PATH', targetPath, userEmail);
        }
      } else {
        // Just ensure targetPath is configured
        if (targetPath) {
          await this.safeSaveSetting('SYNC_FILE_PATH', targetPath, userEmail);
        }
      }

      const fakeFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: selectedExcel.name || 'data.xlsx',
        encoding: '7bit',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: buffer ? buffer.length : 0,
        buffer: buffer || Buffer.alloc(0),
        destination: '',
        filename: '',
        path: '',
      } as any;

      // Keep profile images and templates in sync before Excel processing so they are not blocked by Excel locks/errors
      try {
        await this.syncProfileImages(folderItems, accessToken);
      } catch (err) {
        console.error('Failed to sync profile images during OneDrive sync:', err?.message || err);
      }

      try {
        await this.syncTemplateFiles(folderItems, accessToken);
      } catch (err) {
        console.error('Failed to sync template files during OneDrive sync:', err?.message || err);
      }

      const result = await this.employeeService.processExcel(fakeFile, userEmail);

      return res.json({ success: true, result });
    } catch (error) {
      const e = error as any;
      return res.status(500).json({ success: false, message: e?.message || String(error) });
    }
  }

  // Upload a file to be used as the scheduled sync source and save its path
  @Post('upload')
  @UseGuards(ClerkAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: './uploads/sync',
      filename: (req, file, cb) => {
        const name = `selected_sync${extname(file.originalname)}`;
        cb(null, name);
      }
    })
  }))
  async uploadForSync(@Req() req: any, @UploadedFile() file: Express.Multer.File, @Res() res: Response) {
    try {
      if (!file) return res.status(400).json({ success: false, message: 'No file uploaded' });
      const userEmail = req.user?.email;
      const absolutePath = path.join(process.cwd(), 'uploads', 'sync', file.filename);
      await this.safeSaveSetting('SYNC_FILE_PATH', absolutePath, userEmail);
      return res.json({ success: true, path: absolutePath });
    } catch (err) {
      const e = err as any;
      return res.status(500).json({ success: false, message: e?.message || String(err) });
    }
  }

  // Callback endpoint for OAuth redirect. Microsoft will redirect the user here with ?code=...
  @Get('onedrive/callback')
  async oneDriveCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    try {
      if (!code) return res.status(400).send('Missing code');
      const userEmail = state;

      if (userEmail) {
        await this.settingsRepo.save({ key: 'LAST_CONNECTED_USER_EMAIL', value: userEmail });
      }

      const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
      const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
      const redirectUri = process.env.MS_GRAPH_REDIRECT_URI || process.env.MICROSOFT_REDIRECT_URI;

      if (!clientId || !clientSecret || !redirectUri) {
        return res.status(500).send('Microsoft client configuration missing on server.');
      }

      const params = new URLSearchParams();
      params.append('client_id', clientId);
      params.append('scope', 'offline_access Files.ReadWrite User.Read');
      params.append('code', code);
      params.append('redirect_uri', redirectUri);
      params.append('grant_type', 'authorization_code');
      params.append('client_secret', clientSecret);

      const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';
      const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      const tokenResp = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const data = tokenResp.data;
      if (data.access_token) await this.safeSaveSetting('MS_GRAPH_ACCESS_TOKEN', data.access_token, userEmail);
      if (data.refresh_token) await this.safeSaveSetting('MS_GRAPH_REFRESH_TOKEN', data.refresh_token, userEmail);
      if (data.expires_in) {
        const expiresAt = (Date.now() + data.expires_in * 1000).toString();
        await this.safeSaveSetting('MS_GRAPH_TOKEN_EXPIRES_AT', expiresAt, userEmail);
      }

      // Redirect back to frontend dev server with a success flag
      return res.redirect('http://localhost:5173/?ms_connected=1');
    } catch (err) {
      const e = err as any;
      console.error('OneDrive callback error', e?.message || e);
      return res.status(500).send('Failed to complete Microsoft OAuth: ' + (e?.message || String(e)));
    }
  }
}
