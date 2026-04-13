import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app.config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir: string;
  private s3: S3Client | null = null;
  private bucket: string = '';
  private useS3 = false;

  constructor(private readonly config: AppConfigService) {
    this.uploadDir = path.resolve(process.cwd(), 'uploads');
  }

  async onModuleInit() {
    const endpoint = this.config.storageEndpoint;
    const accessKey = this.config.storageAccessKey;
    const secretKey = this.config.storageSecretKey;

    const isRealEndpoint = endpoint && accessKey && secretKey
      && endpoint.startsWith('http') && !endpoint.includes('your-');
    if (isRealEndpoint) {
      this.s3 = new S3Client({
        region: this.config.storageRegion || 'us-east-1',
        endpoint,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        forcePathStyle: true,
      });
      this.bucket = this.config.storageBucket;
      this.useS3 = true;
      this.logger.log(`Storage: S3-compatible (bucket=${this.bucket})`);
    } else {
      try {
        await fs.mkdir(this.uploadDir, { recursive: true });
        this.logger.log(`Storage: local filesystem (${this.uploadDir})`);
      } catch (err) {
        this.logger.error(`Could not create upload directory: ${(err as Error).message}`);
      }
    }
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    if (this.useS3 && this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      this.logger.log(`File uploaded to S3: ${key}`);
      return key;
    }

    const filePath = path.join(this.uploadDir, key);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, body);
    this.logger.log(`File uploaded to disk: ${key}`);
    return key;
  }

  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    if (this.useS3 && this.s3) {
      return getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      );
    }

    const apiUrl = this.config.apiUrl;
    return `${apiUrl}/${this.config.apiPrefix}/files/serve/${encodeURIComponent(key)}`;
  }

  async delete(key: string): Promise<void> {
    if (this.useS3 && this.s3) {
      try {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        this.logger.log(`File deleted from S3: ${key}`);
      } catch (err) {
        this.logger.warn(`Could not delete S3 file ${key}: ${(err as Error).message}`);
      }
      return;
    }

    const filePath = path.join(this.uploadDir, key);
    try {
      await fs.unlink(filePath);
      this.logger.log(`File deleted from disk: ${key}`);
    } catch (err) {
      this.logger.warn(`Could not delete file ${key}: ${(err as Error).message}`);
    }
  }

  getFilePath(key: string): string {
    return path.join(this.uploadDir, key);
  }

  get isS3(): boolean {
    return this.useS3;
  }
}
