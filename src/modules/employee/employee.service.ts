import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { CreateEmployeeDto, UpdateEmployeeDto } from './dto/employee.dto';
import { SystemSetting } from '../email/entities/system-setting.entity';

type WorkbookRow = Record<string, any>;

@Injectable()
export class EmployeeService {
  constructor(
    @InjectRepository(SystemSetting)
    private settingsRepo: Repository<SystemSetting>,
  ) {}

  async create(createEmployeeDto: CreateEmployeeDto) {
    const employees = await this.readEmployeesFromWorkbook();
    const emailKey = String(createEmployeeDto.email || '').trim().toLowerCase();
    const now = new Date();
    const existingIndex = employees.findIndex(emp => String(emp.email || '').trim().toLowerCase() === emailKey);
    const nextEmployee = {
      id: existingIndex >= 0 ? employees[existingIndex].id : this.nextEmployeeId(employees),
      name: String(createEmployeeDto.name).trim(),
      email: emailKey,
      dob: this.parseExcelDate(createEmployeeDto.dob),
      doj: this.parseExcelDate(createEmployeeDto.doj),
      photoUrl: createEmployeeDto.photoUrl || (existingIndex >= 0 ? employees[existingIndex].photoUrl || '' : ''),
      createdAt: existingIndex >= 0 ? employees[existingIndex].createdAt || now : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      employees[existingIndex] = nextEmployee;
    } else {
      employees.push(nextEmployee);
    }

    await this.saveEmployeesToWorkbook(employees);
    await this.syncEmployeeWorkbook();
    return nextEmployee;
  }

  async findAll() {
    return this.readEmployeesFromWorkbook();
  }

  async findOne(id: number) {
    const employees = await this.readEmployeesFromWorkbook();
    return employees.find(emp => emp.id === id) || null;
  }

  async update(id: number, updateEmployeeDto: UpdateEmployeeDto) {
    const employees = await this.readEmployeesFromWorkbook();
    const index = employees.findIndex(emp => emp.id === id);
    if (index === -1) {
      return { affected: 0 };
    }

    const existing = employees[index];
    const updatedName = updateEmployeeDto.name ? String(updateEmployeeDto.name).trim() : existing.name;
    const updatedEmployee = {
      ...existing,
      name: updatedName,
      email: updateEmployeeDto.email ? String(updateEmployeeDto.email).trim().toLowerCase() : existing.email,
      dob: updateEmployeeDto.dob ? this.parseExcelDate(updateEmployeeDto.dob) : existing.dob,
      doj: updateEmployeeDto.doj ? this.parseExcelDate(updateEmployeeDto.doj) : existing.doj,
      photoUrl: updateEmployeeDto.photoUrl ?? existing.photoUrl ?? '',
      updatedAt: new Date(),
    };

    if (existing.name && updatedEmployee.name && existing.name !== updatedEmployee.name) {
      const renamedPhotoUrl = await this.renameProfilePhoto(existing.name, updatedEmployee.name);
      if (renamedPhotoUrl) {
        updatedEmployee.photoUrl = renamedPhotoUrl;
      }
    }

    employees[index] = updatedEmployee;
    await this.saveEmployeesToWorkbook(employees);
    await this.syncEmployeeWorkbook();
    return updatedEmployee;
  }

  async remove(id: number) {
    const employees = await this.readEmployeesFromWorkbook();
    const nextEmployees = employees.filter(emp => emp.id !== id);
    await this.saveEmployeesToWorkbook(nextEmployees);
    await this.syncEmployeeWorkbook();
    return { affected: employees.length - nextEmployees.length };
  }

  async removeMultiple(ids: number[]) {
    const idSet = new Set((ids || []).map(id => Number(id)));
    const employees = await this.readEmployeesFromWorkbook();
    const nextEmployees = employees.filter(emp => !idSet.has(emp.id));
    await this.saveEmployeesToWorkbook(nextEmployees);
    await this.syncEmployeeWorkbook();
    return { affected: employees.length - nextEmployees.length };
  }

  async getTodayEvents() {
    const employees = await this.readEmployeesFromWorkbook();
    const today = new Date();
    const todayMD = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const events = [];
    for (const emp of employees) {
      const dob = emp.dob ? new Date(emp.dob) : null;
      const doj = emp.doj ? new Date(emp.doj) : null;
      const photoUrl = emp.photoUrl || this.resolveProfilePhotoUrl(process.env.STORAGE_DIR || '', String(emp.name).trim());

      if (dob && !isNaN(dob.getTime())) {
        const dobMD = `${String(dob.getMonth() + 1).padStart(2, '0')}-${String(dob.getDate()).padStart(2, '0')}`;
        if (dobMD === todayMD) {
          events.push({
            employeeId: emp.id,
            name: String(emp.name).trim(),
            email: String(emp.email).trim(),
            photoUrl,
            type: 'birthday',
            age: today.getFullYear() - dob.getFullYear(),
            data: { age: today.getFullYear() - dob.getFullYear() },
          });
        }
      }

      if (doj && !isNaN(doj.getTime())) {
        const dojMD = `${String(doj.getMonth() + 1).padStart(2, '0')}-${String(doj.getDate()).padStart(2, '0')}`;
        if (dojMD === todayMD) {
          events.push({
            employeeId: emp.id,
            name: String(emp.name).trim(),
            email: String(emp.email).trim(),
            photoUrl,
            type: 'anniversary',
            years: today.getFullYear() - doj.getFullYear(),
            data: { years: today.getFullYear() - doj.getFullYear() },
          });
        }
      }
    }

    return events;
  }

  async processExcel(file: Express.Multer.File) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const importedRows = XLSX.utils.sheet_to_json(sheet) as WorkbookRow[];

    const existingEmployees = await this.readEmployeesFromWorkbook();
    const emailToEmployee = new Map<string, any>();
    existingEmployees.forEach(emp => {
      const key = String(emp.email || '').trim().toLowerCase();
      if (key) {
        emailToEmployee.set(key, emp);
      }
    });

    let added = 0;
    let updated = 0;
    let deleted = 0;
    const mergedEmployees: any[] = [];
    const errors: string[] = [];
    const importedEmails = new Set<string>();

    for (const rawRow of importedRows) {
      try {
        const row = this.normalizeRow(rawRow);
        const name = row.name || row.fullname || row.employeename || row.nameoftheemployee;
        const email = row.email || row.emailid || row.workemail || row.personalemail;
        const dob = row.dob || row.dateofbirth || row.birthday || row.birthdate;
        const doj = row.doj || row.dateofjoining || row.joiningdate || row.hiredate;
        const photoUrl = row.photoimage || row.profileimage || row.profilephoto || row['profile image'] || row.photourl || '';

        if (!name || !email || !dob || !doj) {
          errors.push(`Missing data in row. Required: Name, Email, DOB, DOJ. Found: ${Object.keys(rawRow).join(', ')}`);
          continue;
        }

        const emailKey = String(email).trim().toLowerCase();
        
        // Skip duplicate emails in the same imported sheet
        if (importedEmails.has(emailKey)) {
          continue;
        }
        importedEmails.add(emailKey);

        const existing = emailToEmployee.get(emailKey);
        const nextEmployee = {
          id: existing?.id || this.nextEmployeeId([...existingEmployees, ...mergedEmployees]),
          name: String(name).trim(),
          email: emailKey,
          dob: this.parseExcelDate(dob),
          doj: this.parseExcelDate(doj),
          photoUrl: photoUrl || existing?.photoUrl || '',
          createdAt: existing?.createdAt || new Date(),
          updatedAt: new Date(),
        };

        if (existing) {
          updated++;
        } else {
          added++;
        }

        mergedEmployees.push(nextEmployee);
      } catch (error) {
        errors.push(`Error processing row: ${error.message}`);
      }
    }

    if (mergedEmployees.length === 0 && importedRows.length > 0) {
      errors.push('No valid employee rows could be processed. Overwrite aborted to prevent data loss.');
      return { added: 0, updated: 0, deleted: 0, errors };
    }

    // Count how many existing employees are NOT in the imported list
    existingEmployees.forEach(emp => {
      const key = String(emp.email || '').trim().toLowerCase();
      if (key && !importedEmails.has(key)) {
        deleted++;
      }
    });

    await this.saveEmployeesToWorkbook(mergedEmployees);
    await this.syncEmployeeWorkbook();
    return { added, updated, deleted, errors };
  }

  private parseExcelDate(date: any): string {
    if (date instanceof Date && !isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }

    if (typeof date === 'number') {
      const converted = new Date((date - 25569) * 86400 * 1000);
      return isNaN(converted.getTime()) ? '' : converted.toISOString().split('T')[0];
    }

    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? '' : parsed.toISOString().split('T')[0];
  }

  private normalizeRow(row: WorkbookRow) {
    const normalized: WorkbookRow = {};
    Object.keys(row || {}).forEach(key => {
      normalized[key.toLowerCase().replace(/[^a-z]/g, '')] = row[key];
    });
    return normalized;
  }

  private nextEmployeeId(employees: any[]) {
    return employees.reduce((max, emp) => Math.max(max, Number(emp.id) || 0), 0) + 1;
  }

  private async downloadOneDriveWorkbook(): Promise<Buffer | null> {
    try {
      const accessToken = await this.getFreshGraphAccessToken();
      if (!accessToken) return null;

      const itemSetting = await this.settingsRepo.findOneBy({ key: 'SYNC_ONEDRIVE_ITEM_ID' });
      const itemId = itemSetting?.value || process.env.SYNC_ONEDRIVE_ITEM_ID;
      if (!itemId) return null;

      const urlById = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`;
      const resp = await axios.get(urlById, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${accessToken}` } });
      return Buffer.from(resp.data);
    } catch (err) {
      console.error('Failed to download OneDrive workbook:', err.message || err);
      return null;
    }
  }

  private async uploadOneDriveWorkbook(buffer: Buffer): Promise<boolean> {
    try {
      const accessToken = await this.getFreshGraphAccessToken();
      if (!accessToken) return false;

      const itemSetting = await this.settingsRepo.findOneBy({ key: 'SYNC_ONEDRIVE_ITEM_ID' });
      const itemId = itemSetting?.value || process.env.SYNC_ONEDRIVE_ITEM_ID;
      if (!itemId) return false;

      const urlById = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`;
      await axios.put(urlById, buffer, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
      return true;
    } catch (err) {
      console.error('Failed to upload OneDrive workbook:', err.message || err);
      if (err.response && err.response.status === 423) {
        throw new BadRequestException('The Excel file on OneDrive is currently open/locked. Please close the file in Excel (desktop or browser) and try again.');
      }
      throw err;
    }
  }

  private async readEmployeesFromWorkbook() {
    // 1. Try to download from OneDrive directly
    const buffer = await this.downloadOneDriveWorkbook();
    if (buffer) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (sheetName) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet) as WorkbookRow[];
        return rows
          .map((rawRow, index) => this.mapWorkbookRowToEmployee(rawRow, index + 1))
          .filter(Boolean);
      }
    }

    // 2. Fallback to local file if OneDrive is not connected or fails
    const workbookPath = await this.resolveWorkbookPath();
    if (!workbookPath || !fs.existsSync(workbookPath)) {
      return [];
    }

    const workbook = XLSX.readFile(workbookPath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return [];
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet) as WorkbookRow[];
    return rows
      .map((rawRow, index) => this.mapWorkbookRowToEmployee(rawRow, index + 1))
      .filter(Boolean);
  }

  private mapWorkbookRowToEmployee(rawRow: WorkbookRow, fallbackId: number) {
    const row = this.normalizeRow(rawRow);
    const name = row.name || row.fullname || row.employeename || row.nameoftheemployee;
    const email = row.email || row.emailid || row.workemail || row.personalemail;
    if (!name || !email) {
      return null;
    }

    const dob = row.dob || row.dateofbirth || row.birthday || row.birthdate;
    const doj = row.doj || row.dateofjoining || row.joiningdate || row.hiredate;
    const photoUrl = row.photoimage || row.profileimage || row.profilephoto || row['profileimage'] || row['profile image'] || row.photourl || '';

    return {
      id: fallbackId,
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      dob: this.parseExcelDate(dob),
      doj: this.parseExcelDate(doj),
      photoUrl: String(photoUrl || '').trim(),
      createdAt: rawRow.createdat || rawRow.createdAt || null,
      updatedAt: rawRow.updatedat || rawRow.updatedAt || null,
    };
  }

  private async saveEmployeesToWorkbook(employees: any[]) {
    // 1. Try to update OneDrive directly
    const cloudBuffer = await this.downloadOneDriveWorkbook();
    const workbook = cloudBuffer ? XLSX.read(cloudBuffer, { type: 'buffer' }) : XLSX.utils.book_new();
    const sheetName = workbook.SheetNames[0] || 'Sheet1';

    const rows = employees.map(emp => ({
      'full name': emp.name,
      Email: emp.email,
      DOB: this.toExcelDate(emp.dob),
      DoJ: this.toExcelDate(emp.doj),
      'profile image': emp.photoUrl || '',
    }));

    const sheet = XLSX.utils.json_to_sheet(rows);
    if (workbook.SheetNames.includes(sheetName)) {
      workbook.Sheets[sheetName] = sheet;
    } else {
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    }

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    const uploaded = await this.uploadOneDriveWorkbook(buffer);

    // 2. Always write to local file as a local backup cache
    const workbookPath = await this.ensureWorkbookPath();
    const dir = path.dirname(workbookPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(workbookPath, buffer);

    return workbookPath;
  }

  private async ensureWorkbookPath() {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir || !fs.existsSync(storageDir)) {
      throw new Error('STORAGE_DIR not found');
    }

    const workbookPath = await this.resolveWorkbookPath();
    if (workbookPath) {
      return workbookPath;
    }

    const fallbackPath = path.join(storageDir, 'sync', 'selected_sync.xlsx');
    const fallbackDir = path.dirname(fallbackPath);
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    return fallbackPath;
  }

  private resolveProfilePhotoUrl(storageDir: string, employeeName: string): string {
    if (!storageDir || !fs.existsSync(storageDir)) {
      return '';
    }

    const profilesDir = path.join(storageDir, 'profiles');
    if (!fs.existsSync(profilesDir)) {
      return '';
    }

    const target = this.normalizeName(employeeName);
    const imageFiles = fs.readdirSync(profilesDir).filter(file => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file));
    const exactMatch = imageFiles.find(file => this.normalizeName(path.parse(file).name) === target);

    if (exactMatch) {
      return path.join('profiles', exactMatch);
    }

    const looseMatch = imageFiles.find(file => {
      const base = this.normalizeName(path.parse(file).name);
      return base.includes(target) || target.includes(base);
    });

    if (looseMatch) {
      return path.join('profiles', looseMatch);
    }

    const fuzzyMatch = imageFiles
      .map(file => ({ file, score: this.nameSimilarity(target, this.normalizeName(path.parse(file).name)) }))
      .sort((a, b) => b.score - a.score)[0];

    return fuzzyMatch && fuzzyMatch.score >= 0.82 ? path.join('profiles', fuzzyMatch.file) : '';
  }

  private normalizeName(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  private nameSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const distance = this.levenshteinDistance(a, b);
    return 1 - distance / Math.max(a.length, b.length);
  }

  private levenshteinDistance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }

    return dp[a.length][b.length];
  }

  async syncEmployeeWorkbook() {
    const workbookPath = await this.resolveWorkbookPath();
    if (!workbookPath || !fs.existsSync(workbookPath)) {
      return { success: false, message: 'No workbook found to sync' };
    }

    const workbook = XLSX.readFile(workbookPath);
    await this.pushWorkbookToOneDrive(workbook, workbookPath);
    const firstSheetName = workbook.SheetNames[0];
    const rows = firstSheetName ? (XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName]) as WorkbookRow[]) : [];
    return { success: true, path: workbookPath, rows: rows.length };
  }

  private async uploadProfilePhotoToOneDrive(fileName: string, buffer: Buffer, mimeType: string): Promise<boolean> {
    try {
      const accessToken = await this.getFreshGraphAccessToken();
      if (!accessToken) return false;

      const folderIdSetting = await this.settingsRepo.findOneBy({ key: 'SYNC_ONEDRIVE_FOLDER_ID' });
      const folderId = folderIdSetting?.value || process.env.SYNC_ONEDRIVE_FOLDER_ID;
      if (!folderId) return false;

      const url = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}:/profiles/${encodeURIComponent(fileName)}:/content`;
      await axios.put(url, buffer, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': mimeType || 'application/octet-stream',
        },
      });
      return true;
    } catch (err) {
      console.error('Failed to upload profile photo to OneDrive:', err.message || err);
      return false;
    }
  }

  async saveEmployeeProfilePhoto(employeeId: number, file: Express.Multer.File) {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) {
      throw new Error('STORAGE_DIR not defined');
    }

    const employees = await this.readEmployeesFromWorkbook();
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
      throw new Error(`Employee not found: ${employeeId}`);
    }

    const ext = path.extname(file.originalname || file.filename || '.png') || '.png';
    const safeName = this.normalizeName(employee.name) || `employee_${employeeId}`;
    const fileName = `${safeName}${ext.toLowerCase()}`;

    // Read upload buffer
    let buffer;
    if (file.buffer) {
      buffer = file.buffer;
    } else if (file.path && fs.existsSync(file.path)) {
      buffer = fs.readFileSync(file.path);
    } else {
      throw new Error('Uploaded file has no readable content');
    }

    // 1. Upload directly to OneDrive profiles folder
    await this.uploadProfilePhotoToOneDrive(fileName, buffer, file.mimetype);

    // 2. Save locally as backup cache
    const profilesDir = path.join(storageDir, 'profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
    const targetPath = path.join(profilesDir, fileName);
    fs.writeFileSync(targetPath, buffer);

    employee.photoUrl = path.join('profiles', fileName);
    employee.updatedAt = new Date();
    await this.saveEmployeesToWorkbook(employees);
    await this.syncEmployeeWorkbook();
    return { success: true, photoUrl: employee.photoUrl };
  }

  async resolveWorkbookPath() {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir || !fs.existsSync(storageDir)) {
      return null;
    }

    const resolveIfWorkbook = (candidate?: string | null) => {
      if (!candidate || !fs.existsSync(candidate)) return null;
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        const preferred = path.join(candidate, 'selected_sync.xlsx');
        if (fs.existsSync(preferred)) return preferred;
        const files = fs.readdirSync(candidate).filter(f => /\.(xlsx|xls)$/i.test(f));
        if (files.length > 0) return path.join(candidate, files[0]);
      }
      return null;
    };
    try {
      const setting = await this.settingsRepo.findOneBy({ key: 'SYNC_FILE_PATH' });
      const settingPath = resolveIfWorkbook(setting?.value || null);
      if (settingPath) {
        return settingPath;
      }
    } catch (err) {
      // ignore and fall back to filesystem discovery
    }

    const envPath = resolveIfWorkbook(process.env.SYNC_FILE_PATH || process.env.EXCEL_FILE_PATH);
    if (envPath) {
      return envPath;
    }

    const syncDir = path.join(storageDir, 'sync');
    if (fs.existsSync(syncDir)) {
      const syncFile = fs.readdirSync(syncDir).find(f => /\.(xlsx|xls)$/i.test(f));
      if (syncFile) {
        return path.join(syncDir, syncFile);
      }
    }

    const storageFiles = fs.readdirSync(storageDir).filter(f => /\.(xlsx|xls)$/i.test(f));
    if (storageFiles.length > 0) {
      return path.join(storageDir, storageFiles[0]);
    }

    return null;
  }

  private async renameProfilePhoto(oldName: string, newName: string): Promise<string | null> {
    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) return null;

    const profilesDir = path.join(storageDir, 'profiles');
    if (!fs.existsSync(profilesDir)) return null;

    const oldTarget = this.normalizeName(oldName);
    const newTarget = this.normalizeName(newName);
    if (!oldTarget || !newTarget || oldTarget === newTarget) return null;

    const imageFiles = fs.readdirSync(profilesDir).filter(file => /\.(png|jpe?g|webp|gif|bmp)$/i.test(file));
    const match = imageFiles.find(file => this.normalizeName(path.parse(file).name) === oldTarget);
    if (!match) return null;

    const ext = path.extname(match) || '.png';
    const oldPath = path.join(profilesDir, match);
    const newPath = path.join(profilesDir, `${newTarget}${ext}`);

    try {
      fs.copyFileSync(oldPath, newPath);
      if (oldPath !== newPath && fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
      return path.join('profiles', path.basename(newPath));
    } catch (err) {
      // ignore rename issues; workbook sync still proceeds
    }

    return null;
  }

  private async pushWorkbookToOneDrive(workbook: XLSX.WorkBook, excelPath: string) {
    try {
      const itemSetting = await this.settingsRepo.findOneBy({ key: 'SYNC_ONEDRIVE_ITEM_ID' });
      const itemId = itemSetting?.value || process.env.SYNC_ONEDRIVE_ITEM_ID;

      if (!itemId) {
        return;
      }

      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
      const accessToken = await this.getFreshGraphAccessToken();
      if (!accessToken) {
        return;
      }

      await axios.put(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(itemId)}/content`, buffer, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });
    } catch (err) {
      if (err.response && err.response.status === 423) {
        throw new BadRequestException('The Excel file on OneDrive is currently open/locked. Please close the file in Excel (desktop or browser) and try again.');
      }
      // ignore other cloud write-back issues; local workbook is still updated
    }
  }

  private async getFreshGraphAccessToken(): Promise<string | null> {
    const tokenSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_ACCESS_TOKEN' });
    const refreshSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_REFRESH_TOKEN' });
    const expiresSetting = await this.settingsRepo.findOneBy({ key: 'MS_GRAPH_TOKEN_EXPIRES_AT' });

    let accessToken = tokenSetting?.value || process.env.MS_GRAPH_ACCESS_TOKEN || '';
    const refreshToken = refreshSetting?.value || process.env.MS_GRAPH_REFRESH_TOKEN || '';
    const expiresAt = expiresSetting ? parseInt(expiresSetting.value, 10) : 0;
    const now = Date.now();

    if (accessToken && expiresAt && expiresAt - 60000 > now) {
      return accessToken;
    }

    if (!refreshToken) {
      return accessToken || null;
    }

    const clientId = process.env.MS_GRAPH_CLIENT_ID || process.env.MS_CLIENT_ID;
    const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
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

      const tenant = process.env.MS_TENANT_ID || process.env.MS_GRAPH_TENANT_ID || process.env.MS_TENANT || 'common';
      const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
      const tokenResp = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const data = tokenResp.data;
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
    } catch (err) {
      console.error('pushWorkbookToOneDrive: Token refresh failed:', err?.message || err);
      return accessToken || null;
    }
  }

  private toExcelDate(value: any) {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) {
      return '';
    }
    return date.toISOString().split('T')[0];
  }
}
