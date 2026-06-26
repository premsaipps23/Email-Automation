import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { join } from 'path';
import { EmailService } from './modules/email/email.service';
import { SyncController } from './modules/sync/sync.controller';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors();
  
  // Serve static files from the uploads directory
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  const storageDir = process.env.STORAGE_DIR;
  if (storageDir) {
    app.useStaticAssets(join(storageDir, 'templates'), {
      prefix: '/template-assets/',
    });
    app.useStaticAssets(join(storageDir, 'generated templates'), {
      prefix: '/generated-templates/',
    });
  }

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  await app.listen(port);
  console.log(`Application running on http://localhost:${port}`);

  // Simple scheduler: poll settings hourly and run syncs based on frequency
  const emailService = app.get(EmailService);
  const syncController = app.get(SyncController);

  const mockRes = {
    status: (code: number) => {
      console.error(`Scheduled sync failed with status: ${code}`);
      return mockRes;
    },
    json: (data: any) => {
      console.log(`Scheduled sync completed successfully:`, data);
      return mockRes;
    }
  } as any;

  const checkAndRun = async () => {
    try {
      const settings = await emailService.getAllSettings();

      const freq = (settings.SYNC_FREQUENCY || process.env.SYNC_FREQUENCY || 'daily').toLowerCase();
      const now = Date.now();

      // Daily run: check last run timestamp
      const lastDaily = parseInt(settings.SYNC_LAST_DAILY_RUN || '0', 10) || 0;
      const last5 = parseInt(settings.SYNC_LAST_5DAY_RUN || '0', 10) || 0;

      const msPerDay = 24 * 60 * 60 * 1000;

      // Decide which source to run: prefer OneDrive if SYNC_ONEDRIVE_PATH present, otherwise local
      const hasOneDrive = !!(settings.SYNC_ONEDRIVE_PATH || process.env.SYNC_ONEDRIVE_PATH);
      const hasLocal = !!(settings.SYNC_FILE_PATH || process.env.EXCEL_FILE_PATH || process.env.SYNC_FILE_PATH);

      // Daily
      if ((freq === 'daily' || freq === 'both') && (!lastDaily || (now - lastDaily) >= msPerDay)) {
        try {
          if (hasOneDrive) await syncController.runOneDriveSync(mockRes);
          else if (hasLocal) await syncController.runSync(mockRes);
          // update last run
          await emailService.updateSettings({ SYNC_LAST_DAILY_RUN: now.toString() });
        } catch (err) {
          console.error('Scheduled daily sync failed:', err?.message || err);
        }
      }

      // Every 5 days
      if ((freq === 'every5' || freq === 'both') && (!last5 || (now - last5) >= (5 * msPerDay))) {
        try {
          if (hasOneDrive) await syncController.runOneDriveSync(mockRes);
          else if (hasLocal) await syncController.runSync(mockRes);
          await emailService.updateSettings({ SYNC_LAST_5DAY_RUN: now.toString() });
        } catch (err) {
          console.error('Scheduled 5-day sync failed:', err?.message || err);
        }
      }

    } catch (err) {
      console.error('Scheduler check failed:', err?.message || err);
    }
  };

  // Run at startup and then every hour
  checkAndRun();
  setInterval(checkAndRun, 60 * 60 * 1000);
}
bootstrap();
