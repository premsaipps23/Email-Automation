import { Controller, Get, Post, Body, Patch, Param, Delete, UseInterceptors, UploadedFile, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TemplateService } from './template.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { extname } from 'path';
import * as fs from 'fs';
import * as path from 'path';
import { ClerkAuthGuard } from '../../common/guards/clerk-auth.guard';

@Controller('templates')
@UseGuards(ClerkAuthGuard)
export class TemplateController {
  constructor(private templateService: TemplateService) {}

  @Post()
  create(@Body() createTemplateDto: CreateTemplateDto) {
    return this.templateService.create(createTemplateDto);
  }

  @Get()
  findAll() {
    return this.templateService.findAll();
  }

  @Get('type/:type')
  findByType(@Param('type') type: 'birthday' | 'anniversary') {
    return this.templateService.findByType(type);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateTemplateDto: UpdateTemplateDto) {
    return this.templateService.update(+id, updateTemplateDto);
  }

  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      return { success: false, message: 'No image uploaded.' };
    }

    const storageDir = process.env.STORAGE_DIR;
    if (!storageDir) {
      return { success: false, message: 'STORAGE_DIR not defined.' };
    }

    const templatesDir = path.join(storageDir, 'templates');
    if (!fs.existsSync(templatesDir)) {
      fs.mkdirSync(templatesDir, { recursive: true });
    }

    const safeName = path.parse(file.originalname || `template-${id}`).name.replace(/[^a-z0-9-_]/gi, '_').toLowerCase();
    const fileName = `${safeName}${extname(file.originalname || '.png') || '.png'}`;
    const targetPath = path.join(templatesDir, fileName);

    if (file.buffer) {
      fs.writeFileSync(targetPath, file.buffer);
    } else if (file.path && fs.existsSync(file.path)) {
      fs.copyFileSync(file.path, targetPath);
    } else {
      return { success: false, message: 'Uploaded file has no readable content.' };
    }

    const port = process.env.PORT || 3001;
    return {
      success: true,
      imageUrl: `http://localhost:${port}/template-assets/${encodeURIComponent(fileName)}`,
      fileName,
    };
  }

  @Post(':id/set-default')
  setDefault(@Param('id') id: string) {
    return this.templateService.setDefault(+id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.templateService.remove(+id);
  }
}
