import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { extname } from 'path';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';

type HeadVersion = {
  id: string;
  projectId: string | null;
  documentCategory: any;
  clientVisible: boolean;
  version: number;
};

export interface UploadFileParams {
  organizationId: string;
  uploadedById: string;
  taskId?: string;
  messageId?: string;
  projectId?: string;
  clientId?: string;
  originalName: string;
  customName?: string;
  description?: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  category?: 'ATTACHMENT' | 'AVATAR' | 'LOGO' | 'DOCUMENT' | 'IMAGE' | 'OTHER';
  /** @deprecated categories no longer used in UI, kept for backward compat */
  documentCategory?: 'SCOPE' | 'BUDGET' | 'MOCKUP' | 'DOCUMENTATION' | 'OTHER';
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
    const { organizationId, uploadedById, taskId, messageId, projectId, clientId, originalName, customName, description, mimeType, size, buffer, category, documentCategory } = params;

    const ext = extname(originalName);
    const uniqueKey = `${organizationId}/${uuidv4()}${ext}`;

    await this.storage.upload(uniqueKey, buffer, mimeType);

    const file = await this.prisma.file.create({
      data: {
        organizationId,
        uploadedById,
        taskId: taskId || null,
        messageId: messageId || null,
        projectId: projectId || null,
        clientId: clientId || null,
        name: customName?.trim() || originalName,
        originalName,
        description: description?.trim() || null,
        mimeType,
        size,
        url: uniqueKey,
        key: uniqueKey,
        category: category || 'ATTACHMENT',
        documentCategory: documentCategory ?? null,
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

  async getByKey(key: string) {
    return this.prisma.file.findFirst({
      where: { key },
      select: { mimeType: true, originalName: true },
    });
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
    return this.storage.getSignedUrl(file.key, 3600, file.id);
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

    const where = {
      OR: [
        { task: { projectId } },                                    // archivos asociados a tareas (legacy)
        { projectId, deletedAt: null, parentFileId: null },         // documentos directos del proyecto (head versions, no eliminados)
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          task: { select: { id: true, title: true } },
          downloadEvents: {
            select: {
              id: true,
              downloadedAt: true,
              user: { select: { id: true, name: true } },
            },
            orderBy: { downloadedAt: 'desc' },
            take: 5,
          },
          _count: { select: { downloadEvents: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.file.count({ where }),
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

  // ============================================================================
  // PROJECT DOCUMENTS (compartir con cliente)
  // ============================================================================

  async toggleVisibility(fileId: string, userId: string, clientVisible: boolean) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        projectId: true,
        clientVisible: true,
        originalName: true,
        organizationId: true,
        project: { select: { id: true, name: true, clientId: true } },
      },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.projectId || !file.project) {
      throw new AppException('Solo se puede cambiar visibilidad en documentos del proyecto', 'INVALID_FILE_TYPE', 400);
    }

    const wasHidden = !file.clientVisible;

    const updated = await this.prisma.file.update({
      where: { id: fileId },
      data: { clientVisible },
    });

    // Si paso de oculto a visible, emitir evento para notificar al cliente
    if (clientVisible && wasHidden && file.project.clientId) {
      this.eventEmitter.emit('document.shared', {
        fileId,
        fileName: file.originalName,
        projectId: file.projectId,
        projectName: file.project.name,
        clientId: file.project.clientId,
        organizationId: file.organizationId,
        sharedById: userId,
      });
    }

    this.logger.log(`File ${fileId} visibility changed to ${clientVisible} by user ${userId}`);
    return updated;
  }

  async updateCategory(fileId: string, userId: string, documentCategory: 'SCOPE' | 'BUDGET' | 'MOCKUP' | 'DOCUMENTATION' | 'OTHER') {
    const file = await this.prisma.file.findUnique({ where: { id: fileId }, select: { id: true, projectId: true } });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.projectId) {
      throw new AppException('Solo se puede categorizar documentos del proyecto', 'INVALID_FILE_TYPE', 400);
    }
    return this.prisma.file.update({
      where: { id: fileId },
      data: { documentCategory },
    });
  }

  async createVersion(parentFileId: string, params: {
    organizationId: string;
    uploadedById: string;
    originalName: string;
    mimeType: string;
    size: number;
    buffer: Buffer;
  }) {
    // El parent puede ser cualquier nodo de la cadena — buscar el head real
    const head = await this.findHeadVersion(parentFileId);
    if (!head) throw new AppException('Archivo origen no encontrado', 'FILE_NOT_FOUND', 404);
    if (!head.projectId) {
      throw new AppException('Solo se puede versionar documentos del proyecto', 'INVALID_FILE_TYPE', 400);
    }

    const ext = extname(params.originalName);
    const uniqueKey = `${params.organizationId}/${uuidv4()}${ext}`;
    await this.storage.upload(uniqueKey, params.buffer, params.mimeType);

    const newVersion = await this.prisma.file.create({
      data: {
        organizationId: params.organizationId,
        uploadedById: params.uploadedById,
        projectId: head.projectId,
        name: params.originalName,
        originalName: params.originalName,
        mimeType: params.mimeType,
        size: params.size,
        url: uniqueKey,
        key: uniqueKey,
        category: 'ATTACHMENT',
        // Heredar metadatos del head
        documentCategory: head.documentCategory,
        clientVisible: head.clientVisible,
        parentFileId: head.id,
        version: head.version + 1,
      },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.logger.log(`Version v${newVersion.version} created for document ${head.id} -> new id ${newVersion.id}`);
    return newVersion;
  }

  /**
   * Busca el "head" de una cadena de versiones: el archivo mas nuevo
   * (el que NO tiene otra version mas reciente apuntando a el).
   */
  private async findHeadVersion(fileId: string): Promise<HeadVersion | null> {
    let current: HeadVersion | null = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, projectId: true, documentCategory: true, clientVisible: true, version: true },
    });
    if (!current) return null;

    // Buscar la version mas alta que tenga este archivo como parent
    while (current) {
      const child: HeadVersion | null = await this.prisma.file.findFirst({
        where: { parentFileId: current.id, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { id: true, projectId: true, documentCategory: true, clientVisible: true, version: true },
      });
      if (!child) break;
      current = child;
    }
    return current;
  }

  async listVersions(fileId: string) {
    // Subir hasta el origen de la cadena
    let current = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, parentFileId: true },
    });
    if (!current) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);

    while (current.parentFileId) {
      const parent: { id: string; parentFileId: string | null } | null = await this.prisma.file.findUnique({
        where: { id: current.parentFileId },
        select: { id: true, parentFileId: true },
      });
      if (!parent) break;
      current = parent;
    }
    const rootId = current.id;

    // Obtener todas las versiones de la cadena: root + descendientes recursivos
    const all = await this.prisma.file.findMany({
      where: {
        OR: [
          { id: rootId },
          { parentFileId: rootId },
        ],
      },
      include: {
        uploadedBy: { select: { id: true, name: true } },
      },
      orderBy: { version: 'asc' },
    });

    // Para cadenas profundas (v3 -> v2 -> v1), seguir bajando
    const result = [...all];
    let frontier = all.filter((f) => f.id !== rootId).map((f) => f.id);
    while (frontier.length > 0) {
      const next = await this.prisma.file.findMany({
        where: { parentFileId: { in: frontier } },
        include: { uploadedBy: { select: { id: true, name: true } } },
        orderBy: { version: 'asc' },
      });
      if (next.length === 0) break;
      result.push(...next);
      frontier = next.map((f) => f.id);
    }
    return result.sort((a, b) => a.version - b.version);
  }

  async softDeleteDocument(fileId: string, userId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, projectId: true, organizationId: true, originalName: true },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.projectId) {
      throw new AppException('Solo documentos del proyecto soportan soft delete', 'INVALID_FILE_TYPE', 400);
    }

    await this.prisma.file.update({
      where: { id: fileId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    this.logger.log(`Document ${fileId} soft-deleted by user ${userId}`);
    this.eventEmitter.emit('file.deleted', {
      ...domainEvent('file.deleted', 'file', fileId, file.organizationId, userId),
      fileId,
      fileName: file.originalName,
      userId,
    });
    return { deleted: true };
  }

  async recordDownload(fileId: string, userId: string, ipAddress?: string, userAgent?: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, key: true, originalName: true, mimeType: true },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);

    await this.prisma.fileDownloadEvent.create({
      data: {
        fileId,
        userId,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    });

    return file;
  }

  // ============================================================================
  // EDIT DOCUMENT — sobreescribe el archivo y/o metadata (reemplaza versionado)
  // ============================================================================

  async editDocument(
    fileId: string,
    userId: string,
    params: {
      newFile?: { buffer: Buffer; originalName: string; mimeType: string; size: number };
      name?: string;
      description?: string;
    },
  ) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, key: true, organizationId: true, projectId: true, clientId: true, deletedAt: true },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (file.deletedAt) {
      throw new AppException('No se puede editar un archivo eliminado', 'FILE_DELETED', 400);
    }

    const data: Record<string, unknown> = {};

    // 1) Si hay archivo nuevo: subir a S3, borrar el viejo, actualizar key/originalName/mimeType/size
    if (params.newFile) {
      const ext = extname(params.newFile.originalName);
      const newKey = `${file.organizationId}/${uuidv4()}${ext}`;
      await this.storage.upload(newKey, params.newFile.buffer, params.newFile.mimeType);

      // Borrar el archivo viejo de S3 para no acumular blobs huerfanos
      try {
        await this.storage.delete(file.key);
      } catch (err) {
        this.logger.warn(`No se pudo borrar el archivo viejo ${file.key}: ${(err as Error).message}`);
      }

      data.key = newKey;
      data.url = newKey;
      data.originalName = params.newFile.originalName;
      data.mimeType = params.newFile.mimeType;
      data.size = params.newFile.size;
    }

    // 2) Metadata
    if (params.name !== undefined) {
      const trimmed = params.name.trim();
      data.name = trimmed.length > 0 ? trimmed : (params.newFile?.originalName ?? undefined);
    }
    if (params.description !== undefined) {
      data.description = params.description.trim() || null;
    }

    if (Object.keys(data).length === 0) {
      throw new AppException('Sin cambios para aplicar', 'NO_CHANGES', 400);
    }

    const updated = await this.prisma.file.update({
      where: { id: fileId },
      data,
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.logger.log(`File ${fileId} edited by user ${userId}`);
    return updated;
  }

  // ============================================================================
  // CLIENT DOCUMENTS — documentos a nivel cliente (no por proyecto)
  // ============================================================================

  async listByClient(clientId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const where = { clientId, deletedAt: null, parentFileId: null };

    const [data, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          downloadEvents: {
            select: {
              id: true,
              downloadedAt: true,
              user: { select: { id: true, name: true } },
            },
            orderBy: { downloadedAt: 'desc' },
            take: 5,
          },
          _count: { select: { downloadEvents: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.file.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async toggleClientVisibility(fileId: string, userId: string, clientVisible: boolean) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        clientId: true,
        clientVisible: true,
        organizationId: true,
        originalName: true,
        client: { select: { id: true, name: true } },
      },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.clientId) {
      throw new AppException('Este archivo no es un documento del cliente', 'INVALID_FILE_TYPE', 400);
    }

    const updated = await this.prisma.file.update({
      where: { id: fileId },
      data: { clientVisible },
    });

    this.logger.log(`Client document ${fileId} visibility set to ${clientVisible} by user ${userId}`);
    return updated;
  }

  async softDeleteClientDocument(fileId: string, userId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, clientId: true, organizationId: true, originalName: true },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.clientId) {
      throw new AppException('Solo documentos del cliente soportan soft delete por este endpoint', 'INVALID_FILE_TYPE', 400);
    }

    await this.prisma.file.update({
      where: { id: fileId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    this.logger.log(`Client document ${fileId} soft-deleted by user ${userId}`);
    this.eventEmitter.emit('file.deleted', {
      ...domainEvent('file.deleted', 'file', fileId, file.organizationId, userId),
      fileId,
      fileName: file.originalName,
      userId,
    });
    return { deleted: true };
  }

  /**
   * Helper for controllers/services to validate ownership before operating
   * on a client document. Returns the file or throws.
   */
  async getClientDocumentForOrg(fileId: string, organizationId: string) {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, clientId: true, organizationId: true },
    });
    if (!file) throw new AppException('Archivo no encontrado', 'FILE_NOT_FOUND', 404);
    if (!file.clientId) {
      throw new AppException('No es un documento del cliente', 'INVALID_FILE_TYPE', 400);
    }
    if (file.organizationId !== organizationId) {
      throw new AppException('Sin acceso a este documento', 'FORBIDDEN', 403);
    }
    return file;
  }
}
