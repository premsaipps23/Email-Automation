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
    bodyMessage?: string,
  ): Promise<Buffer> {
    const finalBuffer = await this.generateWithSharp(
      templatePath,
      photoPath,
      name,
      greeting,
      imageConfig,
      nameConfig,
      nameCoverConfig,
      greetingConfig,
      badgeConfig,
      badgeValue,
      bodyMessage,
    );
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

  private async generateWithSharp(
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
    bodyMessage?: string,
  ) {
    const templateMetadata = await sharp(templatePath).metadata();
    const tWidth = templateMetadata.width || 1000;
    const tHeight = templateMetadata.height || 1000;

    const isBirthday = path.basename(templatePath).toLowerCase().includes('birthday')
      || path.basename(templatePath).toLowerCase().includes('bday')
      || path.basename(templatePath).toLowerCase().includes('birth');

    let photoX: number;
    let photoY: number;
    let photoSize: number;
    let strokeWidth: number;
    let gap: number;
    let innerSize: number;
    let innerX: number;
    let innerY: number;
    let cx = 0;
    let cy = 0;
    let rNew = 0;

    const composites: sharp.OverlayOptions[] = [];

    if (isBirthday) {
      cx = Math.round(tWidth * 0.494);
      cy = Math.round(tHeight * 0.420);
      const rxOriginal = Math.round(tWidth * 0.208);
      const ryOriginal = Math.round(tHeight * 0.212);
      
      strokeWidth = Math.round(tHeight * 0.0125);
      rNew = Math.round(tHeight * 0.14); // Perfect circle photo size
      gap = Math.round(tHeight * 0.005); // Reduce the white space gap
      
      innerSize = Math.round((rNew * 2) - (strokeWidth * 2) - (gap * 2));
      innerX = cx - Math.round(innerSize / 2);
      innerY = cy - Math.round(innerSize / 2);
      
      photoSize = rNew * 2;
      photoX = cx - rNew;
      photoY = cy - rNew;

      // 1. Cover the old text region (from 57% to 89% of the template height)
      const coverLeft = Math.round(tWidth * 0.10);
      const coverTop = Math.round(tHeight * 0.57);
      const coverWidth = Math.round(tWidth * 0.80);
      const coverHeight = Math.round(tHeight * 0.32);
      const whiteTextCoverSvg = Buffer.from(`
        <svg width="${coverWidth}" height="${coverHeight}">
          <rect x="0" y="0" width="${coverWidth}" height="${coverHeight}" fill="#ffffff" />
        </svg>
      `);
      composites.push({ input: whiteTextCoverSvg, top: coverTop, left: coverLeft });

      // 2. Cover the old ellipse/oval region using an SVG ellipse
      // Make sure the top of the cover (cy - ryCover) does not go above the bottom of the logo text (y = 100)
      const rxCover = rxOriginal + Math.round(tWidth * 0.01);
      const ryCover = Math.min(
        ryOriginal + Math.round(tHeight * 0.004),
        cy - Math.round(tHeight * 0.207)
      );
      const ellipseCoverWidth = rxCover * 2;
      const ellipseCoverHeight = ryCover * 2;
      const whiteEllipseCoverSvg = Buffer.from(`
        <svg width="${ellipseCoverWidth}" height="${ellipseCoverHeight}">
          <ellipse cx="${rxCover}" cy="${ryCover}" rx="${rxCover}" ry="${ryCover}" fill="#ffffff" />
        </svg>
      `);
      composites.push({
        input: whiteEllipseCoverSvg,
        top: cy - ryCover,
        left: cx - rxCover
      });
    } else {
      const useNativeCoordinates = imageConfig?.coordinateMode === 'template'
        || nameConfig?.coordinateMode === 'template'
        || greetingConfig?.coordinateMode === 'template';
      const referenceWidth = 1254; // Coordinates in template.service.ts are designed for 1254x1254
      const scaleX = useNativeCoordinates ? (tWidth / referenceWidth) : tWidth / 1000;
      const scaleY = useNativeCoordinates ? (tHeight / referenceWidth) : tHeight / 1000;
      const scaleMin = Math.min(scaleX, scaleY);

      const photoShape = String(imageConfig?.shape || imageConfig?.borderShape || 'circle').toLowerCase();
      const designedWidth = Math.max(imageConfig?.width || 350, imageConfig?.height || 350);
      const designedHeight = designedWidth;
      const photoWidth = Math.round(designedWidth * scaleX);
      const photoHeight = Math.round(designedHeight * scaleY);
      photoSize = photoShape === 'circle'
        ? Math.max(1, Math.round(Math.min(photoWidth, photoHeight)))
        : Math.max(1, photoWidth);

      photoX = Math.round((imageConfig?.x || 325) * scaleX);
      photoY = Math.round((imageConfig?.y || 150) * scaleY);
      strokeWidth = Math.max(6, Math.round(photoSize * 0.03));

      // To put a small gap between the photo and the orange frame,
      // the inner photo size is slightly smaller than the inner boundary of the stroke.
      gap = Math.round(scaleMin * 3);
      innerSize = photoShape === 'circle'
        ? Math.max(1, photoSize - (strokeWidth * 2) - (gap * 2))
        : photoSize;
      innerX = photoX + Math.round((photoSize - innerSize) / 2);
      innerY = photoY + Math.round((photoSize - innerSize) / 2);

      // Erase any legacy background oval lines from the template image with a white cover block
      const coverPadX = Math.round(scaleMin * 50);
      const coverPadY = Math.round(scaleMin * 65);
      const photoCoverWidth = photoSize + coverPadX * 2;
      const photoCoverHeight = photoSize + coverPadY * 2;
      const photoCoverLeft = Math.max(0, photoX - coverPadX);
      const photoCoverTop = Math.max(0, photoY - coverPadY);

      const whiteCoverSvg = Buffer.from(`
        <svg width="${photoCoverWidth}" height="${photoCoverHeight}">
          <rect x="0" y="0" width="${photoCoverWidth}" height="${photoCoverHeight}" fill="#ffffff" />
        </svg>
      `);
      composites.push({ input: whiteCoverSvg, top: photoCoverTop, left: photoCoverLeft });
    }

    if (photoPath && fs.existsSync(photoPath)) {
      const maskRadius = Math.round(innerSize / 2);
      const circleMask = Buffer.from(`
        <svg width="${innerSize}" height="${innerSize}">
          <circle cx="${maskRadius}" cy="${maskRadius}" r="${maskRadius}" fill="#ffffff" />
        </svg>
      `);
      const processedPhoto = await sharp(photoPath)
        .resize(innerSize, innerSize, { fit: 'cover', position: 'centre' })
        .composite([{ input: circleMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      composites.push({ input: processedPhoto, top: innerY, left: innerX });
    }

    let overlaySvg = '';

    if (isBirthday) {
      const headingFontSize = Math.round(tHeight * 0.055);
      const nameFontSize = Math.round(tHeight * 0.04);
      const bodyFontSize = Math.round(tHeight * 0.024);

      // Spacing heights
      const photoBottom = cy + rNew;
      const spacePhotoToHeading = Math.round(tHeight * 0.04);
      const headingY = photoBottom + spacePhotoToHeading;
      const headingBaselineY = headingY + headingFontSize;

      const spaceHeadingToName = Math.round(tHeight * 0.015);
      const nameStartY = headingY + headingFontSize + spaceHeadingToName;

      // Wrap the name to max 2 lines
      const nameLines = this.wrapText(name, 20).slice(0, 2);
      const nameTextElements = nameLines.map((line, i) => {
        const lineY = nameStartY + nameFontSize + i * Math.round(nameFontSize * 1.25);
        return `
          <text
            x="${Math.round(tWidth / 2)}"
            y="${lineY}"
            text-anchor="middle"
            style="fill: #F57C00; font-size: ${nameFontSize}px; font-weight: 700; font-family: Arial, sans-serif;"
          >${this.escapeXml(line)}</text>
        `;
      }).join('\n');

      const nameBottomY = nameStartY + nameLines.length * nameFontSize + (nameLines.length - 1) * Math.round(nameFontSize * 0.25);
      const spaceNameToBody = Math.round(tHeight * 0.035);
      const bodyStartY = nameBottomY + spaceNameToBody;

      // Use provided bodyMessage or default
      const message = (bodyMessage || "Wishing you a year filled with joy, laughter, and wonderful memories. Thank you for being such a valuable part of our team!").trim();
      const cleanMessage = message.replace(/<[^>]*>/g, '');
      const bodyLines = this.wrapText(cleanMessage, 48);

      const bodyTextElements = bodyLines.map((line, i) => {
        const lineY = bodyStartY + bodyFontSize + i * Math.round(bodyFontSize * 1.5);
        return `
          <text
            x="${Math.round(tWidth / 2)}"
            y="${lineY}"
            text-anchor="middle"
            style="fill: #555555; font-size: ${bodyFontSize}px; font-family: Arial, sans-serif;"
          >${this.escapeXml(line)}</text>
        `;
      }).join('\n');

      overlaySvg = `
        <svg width="${tWidth}" height="${tHeight}">
          <!-- Circular orange border -->
          <circle
            cx="${cx}"
            cy="${cy}"
            r="${rNew - Math.round(strokeWidth / 2)}"
            fill="none"
            stroke="#ff7a00"
            stroke-width="${strokeWidth}"
          />
          
          <!-- Happy Birthday heading -->
          <text
            x="${Math.round(tWidth / 2)}"
            y="${headingBaselineY}"
            text-anchor="middle"
            style="fill: #162447; font-size: ${headingFontSize}px; font-weight: 600; font-family: Arial, sans-serif;"
          >${this.escapeXml(greeting)}</text>

          <!-- Employee Name -->
          ${nameTextElements}

          <!-- Body Message -->
          ${bodyTextElements}
        </svg>
      `;
    } else {
      const useNativeCoordinates = imageConfig?.coordinateMode === 'template'
        || nameConfig?.coordinateMode === 'template'
        || greetingConfig?.coordinateMode === 'template';
      const referenceWidth = 1254;
      const scaleX = useNativeCoordinates ? (tWidth / referenceWidth) : tWidth / 1000;
      const scaleY = useNativeCoordinates ? (tHeight / referenceWidth) : tHeight / 1000;
      const scaleMin = Math.min(scaleX, scaleY);

      const photoShape = String(imageConfig?.shape || imageConfig?.borderShape || 'circle').toLowerCase();
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

      overlaySvg = `
        <svg width="${tWidth}" height="${tHeight}">
          ${photoShape === 'circle' ? `
            <circle
              cx="${photoX + Math.round(photoSize / 2)}"
              cy="${photoY + Math.round(photoSize / 2)}"
              r="${Math.round(photoSize / 2) - Math.round(strokeWidth / 2)}"
              fill="none"
              stroke="${imageConfig?.borderColor || '#ff7a00'}"
              stroke-width="${strokeWidth}"
            />
          ` : ''}
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
    }

    return sharp(templatePath)
      .composite([
        ...composites,
        { input: Buffer.from(overlaySvg), top: 0, left: 0 },
      ])
      .png()
      .toBuffer();
  }

  private wrapText(text: string, maxCharsPerLine: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= maxCharsPerLine) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
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
