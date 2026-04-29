import {
  Controller,
  Post,
  Patch,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  ForbiddenException,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  NotFoundException,
  FileTypeValidator,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs/promises';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { FileService } from './file.service';
import { FilePermissionsService } from './file.permissions';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateDocumentVisibilityDto } from './dto/update-document.dto';
import { EditDocumentDto } from './dto/edit-document.dto';
import { Request } from 'express';

const DOCUMENT_FILE_TYPES =
  /^(image\/(jpeg|png|webp|gif|svg\+xml)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats.*|application\/zip|application\/msword|application\/vnd\.ms-excel)$/;

@ApiTags('Files')
@ApiBearerAuth()
@Controller()
export class FileController {
  constructor(
    private readonly fileService: FileService,
    private readonly storage: StorageService,
    private readonly filePermissions: FilePermissionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('files/upload')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Subir un archivo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        taskId: { type: 'string' },
        category: { type: 'string', enum: ['ATTACHMENT', 'AVATAR', 'LOGO', 'DOCUMENT', 'IMAGE', 'OTHER'] },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({
            fileType: /^(image\/(jpeg|png|webp|gif|svg\+xml)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats.*)$/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
    @Query('taskId') taskId?: string,
    @Query('messageId') messageId?: string,
    @Query('projectId') projectId?: string,
    @Query('category') category?: 'ATTACHMENT' | 'AVATAR' | 'LOGO' | 'DOCUMENT' | 'IMAGE' | 'OTHER',
  ) {
    return this.fileService.upload({
      organizationId: user.organizationId!,
      uploadedById: user.id,
      taskId,
      messageId,
      projectId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      category,
    });
  }

  // PUBLIC — must be declared BEFORE files/:id to avoid route collision
  @Get('files/:id/raw')
  @ApiOperation({ summary: 'Servir archivo por ID (publico, sin auth)' })
  async serveFileById(@Param('id') id: string, @Res() res: Response) {
    const file = await this.fileService.getById(id);
    const filePath = this.storage.getFilePath(file.key);

    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException('Archivo no encontrado en disco');
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.originalName || 'file'}"`);
    res.sendFile(filePath);
  }

  @Get('files/:id/download')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Obtener URL de descarga firmada' })
  async download(@Param('id') id: string) {
    const url = await this.fileService.getDownloadUrl(id);
    return { url };
  }

  @Get('files/:id')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Obtener metadatos del archivo' })
  async getById(@Param('id') id: string) {
    return this.fileService.getById(id);
  }

  @Delete('files/:id')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Eliminar un archivo' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.fileService.delete(id, user.id);
  }

  @Get('projects/:projectId/files')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Listar archivos de un proyecto' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listByProject(
    @Param('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.fileService.listByProject(
      projectId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('tasks/:taskId/files')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Listar archivos adjuntos de una tarea' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listByTask(
    @Param('taskId') taskId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.fileService.listByTask(
      taskId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // ============================================================================
  // PROJECT DOCUMENTS — compartir con cliente
  // ============================================================================

  @Post('projects/:projectId/documents')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Subir documento al proyecto (privado por default)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProjectDocument(
    @Param('projectId') projectId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: DOCUMENT_FILE_TYPES }),
        ],
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
    @Query('title') title?: string,
    @Query('description') description?: string,
  ) {
    const allowed = await this.filePermissions.canManageProjectDocument(user.id, projectId);
    if (!allowed) {
      throw new ForbiddenException('No tenés permiso para subir documentos en este proyecto');
    }
    return this.fileService.upload({
      organizationId: user.organizationId!,
      uploadedById: user.id,
      projectId,
      originalName: file.originalname,
      customName: title,
      description,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      category: 'DOCUMENT',
    });
  }

  @Patch('documents/:fileId/visibility')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Cambiar visibilidad para el cliente (ojito) — project o client document' })
  async toggleDocumentVisibility(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateDocumentVisibilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const file = await this.fileService.getById(fileId);

    // Project document: requiere permiso de project doc manager
    if (file.projectId) {
      const allowed = await this.filePermissions.canManageProjectDocument(user.id, file.projectId);
      if (!allowed) {
        throw new ForbiddenException('Solo el responsable, Owners y Project Managers pueden cambiar la visibilidad');
      }
      return this.fileService.toggleVisibility(fileId, user.id, dto.clientVisible);
    }

    // Client document: cualquier user de la org
    if (file.clientId) {
      if (file.organizationId !== user.organizationId) {
        throw new ForbiddenException('Sin acceso a este documento');
      }
      return this.fileService.toggleClientVisibility(fileId, user.id, dto.clientVisible);
    }

    throw new ForbiddenException('Este archivo no es un documento gestionable');
  }

  @Patch('documents/:fileId/edit')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Editar documento (sobreescribe archivo y/o metadata)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async editDocument(
    @Param('fileId') fileId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: EditDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.fileService.getById(fileId);

    // Validar permisos segun el tipo de documento
    if (existing.projectId) {
      const allowed = await this.filePermissions.canManageProjectDocument(user.id, existing.projectId);
      if (!allowed) {
        throw new ForbiddenException('Sin permiso para editar este documento');
      }
    } else if (existing.clientId) {
      if (existing.organizationId !== user.organizationId) {
        throw new ForbiddenException('Sin acceso a este documento');
      }
    } else {
      throw new ForbiddenException('Este archivo no se puede editar por este endpoint');
    }

    // Validar tipo MIME del nuevo archivo si viene
    if (file && !DOCUMENT_FILE_TYPES.test(file.mimetype)) {
      throw new AppException('Tipo de archivo no permitido', 'INVALID_FILE_TYPE', 400, { mimeType: file.mimetype });
    }
    if (file && file.size > 10 * 1024 * 1024) {
      throw new AppException('El archivo excede 10MB', 'FILE_TOO_LARGE', 400);
    }

    return this.fileService.editDocument(fileId, user.id, {
      newFile: file
        ? {
            buffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
          }
        : undefined,
      name: dto.name,
      description: dto.description,
    });
  }

  @Delete('documents/:fileId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Eliminar documento (soft delete) — project o client document' })
  async softDeleteDocument(
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const file = await this.fileService.getById(fileId);

    if (file.projectId) {
      const allowed = await this.filePermissions.canManageProjectDocument(user.id, file.projectId);
      if (!allowed) {
        throw new ForbiddenException('Sin permiso para eliminar documentos del proyecto');
      }
      return this.fileService.softDeleteDocument(fileId, user.id);
    }

    if (file.clientId) {
      if (file.organizationId !== user.organizationId) {
        throw new ForbiddenException('Sin acceso a este documento');
      }
      return this.fileService.softDeleteClientDocument(fileId, user.id);
    }

    throw new ForbiddenException('Este archivo no es un documento gestionable');
  }

  @Get('documents/:fileId/download')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Descargar documento (registra evento de descarga)' })
  async downloadDocument(
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ipAddress = (req.ip || (req.headers['x-forwarded-for'] as string) || '').toString();
    const userAgent = (req.headers['user-agent'] as string) || undefined;
    const file = await this.fileService.recordDownload(fileId, user.id, ipAddress, userAgent);
    const url = await this.storage.getSignedUrl(file.key, 3600, file.id);
    return res.redirect(url);
  }

  // ============================================================================
  // CLIENT DOCUMENTS — documentos a nivel cliente
  // Cualquier user autenticado de la organizacion puede gestionarlos.
  // Multi-tenancy: validar que el cliente pertenezca a la org del JWT.
  // ============================================================================

  private async assertClientBelongsToOrg(clientId: string, organizationId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId },
      select: { id: true },
    });
    if (!client) {
      throw new AppException('Cliente no encontrado en esta organizacion', 'CLIENT_NOT_FOUND', 404, { clientId });
    }
  }

  @Post('clients/:clientId/documents')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Subir documento a nivel cliente' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadClientDocument(
    @Param('clientId') clientId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: DOCUMENT_FILE_TYPES }),
        ],
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
    @Query('title') title?: string,
    @Query('description') description?: string,
    @Query('clientVisible') clientVisible?: string,
  ) {
    await this.assertClientBelongsToOrg(clientId, user.organizationId!);

    const created = await this.fileService.upload({
      organizationId: user.organizationId!,
      uploadedById: user.id,
      clientId,
      originalName: file.originalname,
      customName: title,
      description,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      category: 'DOCUMENT',
    });

    if (clientVisible === 'true') {
      return this.fileService.toggleClientVisibility(created.id, user.id, true);
    }
    return created;
  }

  @Get('clients/:clientId/documents')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Listar documentos de un cliente' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listClientDocuments(
    @Param('clientId') clientId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.assertClientBelongsToOrg(clientId, user.organizationId!);
    return this.fileService.listByClient(
      clientId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }
}
