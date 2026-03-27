import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app.config';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir: string;

  constructor(private readonly config: AppConfigService) {
    this.uploadDir = path.resolve(process.cwd(), 'uploads');
  }

  async onModuleInit() {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true });
      this.logger.log(`Upload directory ready: ${this.uploadDir}`);
    } catch (err) {
      this.logger.error(`Could not create upload directory: ${(err as Error).message}`);
    }
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    const filePath = path.join(this.uploadDir, key);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, body);
    this.logger.log(`File uploaded: ${key}`);
    return key;
  }

  async getSignedUrl(key: string, _expiresIn = 3600): Promise<string> {
    const apiUrl = this.config.apiUrl;
    return `${apiUrl}/${this.config.apiPrefix}/files/serve/${encodeURIComponent(key)}`;
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(this.uploadDir, key);
    try {
      await fs.unlink(filePath);
      this.logger.log(`File deleted: ${key}`);
    } catch (err) {
      this.logger.warn(`Could not delete file ${key}: ${(err as Error).message}`);
    }
  }

  getFilePath(key: string): string {
    return path.join(this.uploadDir, key);
  }
}
