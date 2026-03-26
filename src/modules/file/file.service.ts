import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { extname } from 'path';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

export interface UploadFileParams {
  organizationId: string;
  uploadedById: string;
  taskId?: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  category?: 'ATTACHMENT' | 'AVATAR' | 'LOGO' | 'DOCUMENT' | 'IMAGE' | 'OTHER';
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async upload(params: UploadFileParams) {
    const { organizationId, uploadedById, taskId, originalName, mimeType, size, buffer, category } = params;

    const ext = extname(originalName);
    const uniqueKey = `${organizationId}/${uuidv4()}${ext}`;

    await this.storage.upload(uniqueKey, buffer, mimeType);

    const file = await this.prisma.file.create({
      data: {
        organizationId,
        uploadedById,
        taskId: taskId || null,
        name: originalName,
        originalName,
        mimeType,
        size,
        url: uniqueKey,
        key: uniqueKey,
        category: category || 'ATTACHMENT',
      },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.logger.log(`File uploaded: ${file.id} (${originalName}) by user ${uploadedById}`);

    this.eventEmitter.emit('file.uploaded', {
      ...domainEvent('file.uploaded', 'file', file.id, organizationId, uploadedById),
      fileId: file.id,
      fileName: originalName,
      taskId: taskId || null,
      userId: uploadedById,
    });

    return file;
  }

  async getById(fileId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
        task: { select: { id: true, title: true } },
      },
    });

    if (!file) {
      throw new AppException('El archivo no existe', 'FILE_NOT_FOUND', 404, { fileId });
    }

    return file;
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    const file = await this.getById(fileId);
    return this.storage.getSignedUrl(file.key);
  }

  async delete(fileId: string, userId: string) {
    const file = await this.getById(fileId);

    await this.storage.delete(file.key);

    await this.prisma.file.delete({ where: { id: fileId } });

    this.logger.log(`File deleted: ${fileId} by user ${userId}`);

    this.eventEmitter.emit('file.deleted', {
      ...domainEvent('file.deleted', 'file', fileId, file.organizationId, userId),
      fileId,
      fileName: file.originalName,
      taskId: file.taskId,
      userId,
    });

    return { deleted: true };
  }

  async listByProject(projectId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.file.findMany({
        where: {
          task: { projectId },
        },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          task: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.file.count({
        where: {
          task: { projectId },
        },
      }),
    ]);

    return { data, total, page, limit };
  }

  async listByTask(taskId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.file.findMany({
        where: { taskId },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.file.count({ where: { taskId } }),
    ]);

    return { data, total, page, limit };
  }
}
