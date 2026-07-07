import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type TemplateType = 'birthday' | 'anniversary';

type FileTemplate = {
  id: string;
  name: string;
  fileName: string;
  type: TemplateType | 'general';
  imageUrl: string;
  isDefault: boolean;
  modifiedAt: number;
  subject?: string;
  htmlContent?: string;
  greetingTemplate?: string;
  imageConfig?: { x: number; y: number; width: number; height: number };
  nameConfig?: { x: number; y: number; fontSize: number; color: string };
  nameCoverConfig?: { x: number; y: number; width: number; height: number; color?: string };
  greetingConfig?: { x: number; y: number; fontSize: number; color: string; width?: number };
  badgeConfig?: { x: number; y: number; fontSize: number; color: string; bgColor?: string; bgWidth?: number; bgHeight?: number };
};

@Injectable()
export class TemplateService {
  private readonly supportedExtensions = /\.(png|jpe?g|webp|gif|bmp)$/i;
  private readonly birthdayGreetingTemplate = 'Happy {AGE}{ORDINAL} Birthday!';
  private readonly anniversaryGreetingTemplate = 'Happy Work Anniversary';

  findAll() {
    return this.listTemplateFiles().map(file => ({
      ...file,
      ...this.getTemplateContent(file.type as TemplateType, file.fileName),
    }));
  }

  async findByType(type: TemplateType) {
    const files = this.listTemplateFiles();
    const match = files.find(file => file.type === type);
    if (!match) {
      return this.getTemplateContent(type, '');
    }

    return {
      ...match,
      ...this.getTemplateContent(type, match.fileName),
    };
  }

  create(..._args: any[]) {
    return {
      success: false,
      message: 'Templates are managed from the HR Email Automation/templates folder.',
    };
  }

  update(..._args: any[]) {
    return {
      success: false,
      message: 'Template metadata is file-based. Edit the file in the templates folder instead.',
    };
  }

  setDefault(..._args: any[]) {
    return {
      success: false,
      message: 'Default template selection is file-based. Use the filename that matches the event type.',
    };
  }

  remove(..._args: any[]) {
    return {
      success: false,
      message: 'Remove the image file from the templates folder to delete a template.',
    };
  }

  renderTemplate(template: any, variables: Record<string, string>) {
    let content = template.htmlContent || '';
    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`\\{${key}\\}`, 'g');
      content = content.replace(regex, value);
    });
    return content;
  }

  buildEmailHtml(template: any, variables: Record<string, string>, photoCid?: string) {
    const name = variables['NAME'] || '';
    const greetingRaw = template.greetingTemplate || '';

    let greeting = greetingRaw;
    Object.entries(variables).forEach(([k, v]) => {
      greeting = greeting.replace(new RegExp(`\\{${k}\\}`, 'g'), v || '');
    });

    const message = this.renderTemplate(template, variables);
    const website = template.imageUrl ? template.imageUrl.split('/').slice(0, 3).join('/') : '';
    const fallbackGreeting = template?.type === 'anniversary'
      ? this.anniversaryGreetingTemplate
      : this.birthdayGreetingTemplate;

    const photoSrc = photoCid ? `cid:${photoCid}` : (variables['PHOTO_URL'] || '');

    return `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color:#f8fafc; padding:36px 12px; display:flex; justify-content:center;">
        <div style="width:100%; max-width:600px; background:#ffffff; border-radius:12px; box-shadow:0 6px 18px rgba(15,23,42,0.08); overflow:hidden; text-align:center; margin:0 auto;">
          <div style="padding:0;">
            <img src="${template.imageUrl || ''}" alt="banner" width="600" style="width:100%; max-width:600px; height:auto; display:block; border:none;" />
          </div>
          <div style="padding:8px 20px 0; margin-top:-80px;">
            <div style="width:160px; height:160px; margin:0 auto; border-radius:50%; overflow:hidden; border:6px solid #ffffff; display:flex; align-items:center; justify-content:center; background:#ffffff; position:relative; z-index:10;">
              ${photoSrc ? `<img src="${photoSrc}" alt="${name}" width="160" height="160" style="width:160px; height:160px; display:block; border:none;"/>` : `<div style="width:160px;height:160px;background:#f3f4f6;border-radius:50%;"></div>`}
            </div>
          </div>
          <div style="padding:18px 40px 8px;">
            <h1 style="margin:0; font-size:32px; color:#0f172a; font-weight:700;">${greeting || fallbackGreeting}</h1>
            <div style="margin-top:8px; font-size:20px; color:#ff7a18; font-weight:700;">${name}</div>
            <div style="margin-top:16px; color:#475569; font-size:15px; line-height:1.6;">
              ${message}
            </div>
          </div>
          <div style="padding:18px; background:#fff1f0; color:#6b7280; font-size:13px;">
            ${template.imageUrl ? `<a href="${website}" style="color:#374151; text-decoration:none;">${website}</a>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  getTemplatePath(template: any) {
    const templatesDir = this.getTemplatesDir();
    if (!templatesDir || !template?.fileName) {
      return '';
    }

    const fullPath = path.join(templatesDir, path.basename(template.fileName));
    return fs.existsSync(fullPath) ? fullPath : '';
  }

  private getStorageDir() {
    const storageDir = process.env.STORAGE_DIR;
    return storageDir && fs.existsSync(storageDir) ? storageDir : '';
  }

  private getTemplatesDir() {
    const storageDir = this.getStorageDir();
    if (!storageDir) {
      return '';
    }
    const templatesDir = path.join(storageDir, 'templates');
    if (!fs.existsSync(templatesDir)) {
      fs.mkdirSync(templatesDir, { recursive: true });
    }
    return templatesDir;
  }

  private listTemplateFiles(): FileTemplate[] {
    const templatesDir = this.getTemplatesDir();
    if (!templatesDir) {
      return [];
    }

    const files = fs.readdirSync(templatesDir).filter(file => this.supportedExtensions.test(file));
    const mappedFiles = files
      .map(file => {
        const fullPath = path.join(templatesDir, file);
        const stats = fs.statSync(fullPath);
        const type = this.inferType(file);
        return {
          id: file,
          name: file,
          fileName: file,
          type,
          imageUrl: this.getTemplateAssetUrl(file),
          isDefault: false,
          modifiedAt: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return this.dedupeTemplateFiles(mappedFiles);
  }

  private dedupeTemplateFiles(files: FileTemplate[]): FileTemplate[] {
    const seen = new Set<string>();
    const result: FileTemplate[] = [];

    for (const file of files) {
      const isTypedTemplate = file.type === 'birthday' || file.type === 'anniversary';
      const key = isTypedTemplate ? `type:${file.type}` : `file:${file.fileName.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(file);
    }

    return result;
  }

  private inferType(fileName: string): TemplateType | 'general' {
    const normalized = String(fileName || '').toLowerCase();
    if (normalized.includes('birthday') || normalized.includes('bday') || normalized.includes('birth')) {
      return 'birthday';
    }
    if (normalized.includes('anniversary') || normalized.includes('annivesary') || normalized.includes('anniv')) {
      return 'anniversary';
    }
    return 'general';
  }

  private getTemplateAssetUrl(fileName: string) {
    const port = process.env.PORT || 3001;
    return `http://localhost:${port}/template-assets/${encodeURIComponent(fileName)}`;
  }

  private getTemplateContent(type: TemplateType, fileName: string) {
    const selectedImage = fileName ? this.getTemplateAssetUrl(fileName) : '';
    if (type === 'anniversary') {
      return {
        subject: 'Happy Work Anniversary {NAME}!',
        htmlContent: '<p>Congratulations on another successful year with the team! We appreciate your hard work.</p>',
        greetingTemplate: this.anniversaryGreetingTemplate,
        imageConfig: { coordinateMode: 'template', shape: 'circle', x: 355, y: 262, width: 530, height: 530, borderInset: 6 },
        nameConfig: {
          coordinateMode: 'template',
          x: 620,
          y: 935,
          fontSize: 50,
          color: '#ff7a00',
          bgColor: 'transparent',
          bgWidth: 850,
          bgHeight: 70,
        },
        nameCoverConfig: undefined,
        greetingConfig: { coordinateMode: 'template', x: 620, y: 870, fontSize: 40, color: '#0f172a', bgColor: 'transparent' },
        badgeConfig: { coordinateMode: 'template', x: 855, y: 406, fontSize: 30, color: '#ffffff', bgColor: '#ff7a00', bgWidth: 140, bgHeight: 140 },
        imageUrl: selectedImage,
      };
    }

    return {
      subject: 'Happy Birthday {NAME}!',
      htmlContent: '<p>Wishing you a year filled with joy, laughter, and wonderful memories. Thank you for being such a valuable part of our team!</p>',
      greetingTemplate: 'Happy Birthday',
      imageConfig: { coordinateMode: 'template', shape: 'circle', x: 355, y: 262, width: 530, height: 530, borderInset: 6 },
      nameConfig: {
        coordinateMode: 'template',
        x: 620,
        y: 935,
        fontSize: 50,
        color: '#ff7a00',
        bgColor: 'transparent',
        bgWidth: 850,
        bgHeight: 70,
      },
      greetingConfig: { coordinateMode: 'template', x: 620, y: 870, fontSize: 40, color: '#0f172a', bgColor: 'transparent' },
      imageUrl: selectedImage,
    };
  }
}
