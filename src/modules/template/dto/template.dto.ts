import { IsString, IsEnum, IsOptional } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  name: string;

  @IsEnum(['birthday', 'anniversary'])
  type: 'birthday' | 'anniversary';

  @IsString()
  subject: string;

  @IsString()
  htmlContent: string;

  @IsOptional()
  @IsString()
  textContent?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  htmlContent?: string;

  @IsOptional()
  @IsString()
  textContent?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  imageConfig?: { x: number; y: number; width: number; height: number };

  @IsOptional()
  nameConfig?: { x: number; y: number; fontSize?: number; color?: string; bgColor?: string; bgWidth?: number; bgHeight?: number };

  @IsOptional()
  greetingConfig?: { x: number; y: number; fontSize?: number; color?: string; width?: number };

  @IsOptional()
  @IsString()
  greetingTemplate?: string;
}
