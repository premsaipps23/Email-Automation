import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);

  async generateGreetingCard(
    templatePath: string,
    photoPath: string,
    name: string,
    greeting: string,
    imageConfig?: any,
    nameConfig?: any,
    nameCoverConfig?: any,
    greetingConfig?: any,
    badgeConfig?: any,
    badgeValue?: string,
  ): Promise<Buffer> {
    const finalBuffer = await this.generateWithSharp(templatePath, photoPath, name, greeting, imageConfig, nameConfig, nameCoverConfig, greetingConfig, badgeConfig, badgeValue);
    this.archiveGeneratedCard(finalBuffer, name);
    return finalBuffer;
  }

  private archiveGeneratedCard(finalBuffer: Buffer, name: string) {
    try {
      const storageDir = process.env.STORAGE_DIR;
      if (!storageDir) throw new Error('STORAGE_DIR not defined');

      const generatedDir = path.join(storageDir, 'generated templates');
      if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });

      const safeName = name.replace(/[^a-z0-9-_]+/gi, '_');
      const fileName = `generated_card_${Date.now()}_${safeName}.png`;
      fs.writeFileSync(path.join(generatedDir, fileName), finalBuffer);
      this.logger.log(`Card archived at: ${generatedDir}/${fileName}`);
    } catch (saveErr) {
      this.logger.error('Failed to archive generated card:', saveErr.message || saveErr);
    }
  }

  private async generateWithSharp(templatePath: string, photoPath: string, name: string, greeting: string, imageConfig?: any, nameConfig?: any, nameCoverConfig?: any, greetingConfig?: any, badgeConfig?: any, badgeValue?: string) {
    const templateMetadata = await sharp(templatePath).metadata();
    const tWidth = templateMetadata.width || 1000;
    const tHeight = templateMetadata.height || 1000;

    const useNativeCoordinates = imageConfig?.coordinateMode === 'template'
      || nameConfig?.coordinateMode === 'template'
      || greetingConfig?.coordinateMode === 'template';
    const scaleX = useNativeCoordinates ? 1 : tWidth / 1000;
    const scaleY = useNativeCoordinates ? 1 : tHeight / 1000;
    const scaleMin = Math.min(scaleX, scaleY);

    const photoShape = String(imageConfig?.shape || imageConfig?.borderShape || 'circle').toLowerCase();
    const designedWidth = imageConfig?.width || 350;
    const designedHeight = imageConfig?.height || 350;
    const photoWidth = Math.round(designedWidth * scaleX);
    const photoHeight = Math.round(designedHeight * scaleY);
    const photoSize = photoShape === 'circle'
      ? Math.max(1, Math.round(Math.min(photoWidth, photoHeight)))
      : Math.max(1, photoWidth);

    const photoX = Math.round((imageConfig?.x || 325) * scaleX);
    const photoY = Math.round((imageConfig?.y || 150) * scaleY);
    const borderInset = Number.isFinite(imageConfig?.borderInset)
      ? Math.max(0, Math.round((imageConfig.borderInset || 0) * scaleMin))
      : Math.max(4, Math.round(Math.min(photoWidth, photoHeight) * 0.05));
    const innerWidth = Math.max(1, photoSize - borderInset * 2);
    const innerHeight = Math.max(1, photoSize - borderInset * 2);
    const innerX = photoX + borderInset;
    const innerY = photoY + borderInset;

    const composites: sharp.OverlayOptions[] = [];
    if (photoPath && fs.existsSync(photoPath)) {
      const maskSize = Math.min(innerWidth, innerHeight);
      const roundedCorners = Buffer.from(`<svg><rect x="0" y="0" width="${maskSize}" height="${maskSize}" rx="${Math.round(maskSize / 2)}" ry="${Math.round(maskSize / 2)}"/></svg>`);
      const processedPhoto = await sharp(photoPath)
        .resize(maskSize, maskSize, { fit: 'cover', position: 'centre' })
        .composite([{ input: roundedCorners, blend: 'dest-in' }])
        .png()
        .toBuffer();
      composites.push({ input: processedPhoto, top: innerY, left: innerX });
    }

    const nameX = Math.round((nameConfig?.x || 500) * scaleX);
    const nameY = Math.round((nameConfig?.y || 700) * scaleY);
    const nameFontSize = Math.round((nameConfig?.fontSize || 54) * scaleMin);
    const greetX = Math.round((greetingConfig?.x || 500) * scaleX);
    const greetY = Math.round((greetingConfig?.y || 820) * scaleY);
    const greetFontSize = Math.round((greetingConfig?.fontSize || 28) * scaleMin);

    const coverWidth = Math.round((nameConfig?.bgWidth || 500) * scaleX);
    const coverHeight = Math.round((nameConfig?.bgHeight || 80) * scaleY);
    const coverX = nameX - Math.round(coverWidth / 2);
    const coverY = nameY - Math.round(coverHeight * 0.75);
    const coverColor = nameConfig?.bgColor || 'transparent';
    const nameCoverX = Math.round((nameCoverConfig?.x || 540) * scaleX);
    const nameCoverY = Math.round((nameCoverConfig?.y || 650) * scaleY);
    const nameCoverWidth = Math.round((nameCoverConfig?.width || 460) * scaleX);
    const nameCoverHeight = Math.round((nameCoverConfig?.height || 48) * scaleY);
    const nameCoverLeft = nameCoverX - Math.round(nameCoverWidth / 2);
    const nameCoverTop = nameCoverY - Math.round(nameCoverHeight / 2);
    const nameCoverColor = nameCoverConfig?.color || '#ffffff';

    const greetCoverWidth = Math.round((greetingConfig?.bgWidth || 500) * scaleX);
    const greetCoverHeight = Math.round((greetingConfig?.bgHeight || 60) * scaleY);
    const greetCoverX = greetX - Math.round(greetCoverWidth / 2);
    const greetCoverY = greetY - Math.round(greetCoverHeight * 0.75);
    const greetCoverColor = greetingConfig?.bgColor || 'transparent';
    const badgeX = Math.round((badgeConfig?.x || 540) * scaleX);
    const badgeY = Math.round((badgeConfig?.y || 560) * scaleY);
    const badgeFontSize = Math.round((badgeConfig?.fontSize || 26) * scaleMin);
    const badgeWidth = Math.round((badgeConfig?.bgWidth || 92) * scaleX);
    const badgeHeight = Math.round((badgeConfig?.bgHeight || 64) * scaleY);
    const badgeLeft = badgeX - Math.round(badgeWidth / 2);
    const badgeTop = badgeY - Math.round(badgeHeight / 2);
    const badgeColor = badgeConfig?.bgColor || '#ff7a00';
    const badgeText = String(badgeValue || '').trim();
    const badgeLines = badgeText ? badgeText.split(/\s+/) : [];

    const overlaySvg = `
      <svg width="${tWidth}" height="${tHeight}">
        ${badgeText ? `<rect x="${badgeLeft}" y="${badgeTop}" width="${badgeWidth}" height="${badgeHeight}" rx="${badgeWidth === badgeHeight ? Math.round(badgeWidth / 2) : Math.round(Math.min(badgeWidth, badgeHeight) / 5)}" ry="${badgeWidth === badgeHeight ? Math.round(badgeHeight / 2) : Math.round(Math.min(badgeWidth, badgeHeight) / 5)}" fill="${badgeColor}" stroke="#ffffff" stroke-width="${Math.round(scaleMin * 4)}" />` : ''}
        ${nameCoverConfig ? `<rect x="${nameCoverLeft}" y="${nameCoverTop}" width="${nameCoverWidth}" height="${nameCoverHeight}" fill="${nameCoverColor}" />` : ''}
        ${coverColor !== 'transparent' ? `<rect x="${coverX}" y="${coverY}" width="${coverWidth}" height="${coverHeight}" fill="${coverColor}" />` : ''}
        ${greetCoverColor !== 'transparent' ? `<rect x="${greetCoverX}" y="${greetCoverY}" width="${greetCoverWidth}" height="${greetCoverHeight}" fill="${greetCoverColor}" />` : ''}
        ${badgeText ? `
          <text x="${badgeX}" y="${badgeY - 8}" text-anchor="middle" style="fill: #ffffff; font-size: ${Math.round(badgeFontSize * 1.35)}px; font-weight: 700; font-family: Arial;">
            ${this.escapeXml(badgeLines[0] || badgeText)}
          </text>
          <text x="${badgeX}" y="${badgeY + 18}" text-anchor="middle" style="fill: #ffffff; font-size: ${Math.round(badgeFontSize * 0.65)}px; font-weight: 600; font-family: Arial; letter-spacing: 0.4px;">
            ${this.escapeXml(badgeLines[1] || 'Years')}
          </text>
        ` : ''}
        <text
          x="${nameX}"
          y="${nameY}"
          text-anchor="middle"
          style="fill: ${nameConfig?.color || '#FF7B00'}; font-size: ${nameFontSize}px; font-weight: bold; font-family: Arial;"
        >${this.escapeXml(name)}</text>
        <text
          x="${greetX}"
          y="${greetY}"
          text-anchor="middle"
          style="fill: ${greetingConfig?.color || '#4D4D4D'}; font-size: ${greetFontSize}px; font-family: Arial;"
        >${this.escapeXml(greeting)}</text>
      </svg>`;

    return sharp(templatePath)
      .composite([
        ...composites,
        { input: Buffer.from(overlaySvg), top: 0, left: 0 },
      ])
      .png()
      .toBuffer();
  }

  private escapeXml(value: string) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
