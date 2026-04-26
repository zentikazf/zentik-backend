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
import {
  UpdateDocumentVisibilityDto,
  UpdateDocumentCategoryDto,
} from './dto/update-document.dto';
import { Request } from 'express';

@ApiTags('Files')
@ApiBearerAuth()
@Controller()
export class FileController {
  constructor(
    private readonly fileService: FileService,
    private readonly storage: StorageService,
    private readonly filePermissions: FilePermissionsService,
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
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB
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
    @Query('documentCategory') documentCategory?: 'SCOPE' | 'BUDGET' | 'MOCKUP' | 'DOCUMENTATION' | 'OTHER',
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
      documentCategory,
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
          new FileTypeValidator({
            fileType: /^(image\/(jpeg|png|webp|gif|svg\+xml)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats.*|application\/zip|application\/msword|application\/vnd\.ms-excel)$/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
    @Query('documentCategory') documentCategory?: 'SCOPE' | 'BUDGET' | 'MOCKUP' | 'DOCUMENTATION' | 'OTHER',
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
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      category: 'DOCUMENT',
      documentCategory,
    });
  }

  @Patch('documents/:fileId/visibility')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Cambiar visibilidad para el cliente (ojito)' })
  async toggleDocumentVisibility(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateDocumentVisibilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const file = await this.fileService.getById(fileId);
    if (!file.projectId) {
      throw new ForbiddenException('Este archivo no es un documento del proyecto');
    }
    const allowed = await this.filePermissions.canManageProjectDocument(user.id, file.projectId);
    if (!allowed) {
      throw new ForbiddenException('Solo el responsable, Owners y Project Managers pueden cambiar la visibilidad');
    }
    return this.fileService.toggleVisibility(fileId, user.id, dto.clientVisible);
  }

  @Patch('documents/:fileId/category')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Cambiar categoría de documento' })
  async updateDocumentCategory(
    @Param('fileId') fileId: string,
    @Body() dto: UpdateDocumentCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const file = await this.fileService.getById(fileId);
    if (!file.projectId) {
      throw new ForbiddenException('Este archivo no es un documento del proyecto');
    }
    const allowed = await this.filePermissions.canManageProjectDocument(user.id, file.projectId);
    if (!allowed) {
      throw new ForbiddenException('Sin permiso para cambiar la categoría');
    }
    return this.fileService.updateCategory(fileId, user.id, dto.documentCategory);
  }

  @Post('documents/:fileId/versions')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Subir nueva versión de un documento' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocumentVersion(
    @Param('fileId') parentFileId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }),
          new FileTypeValidator({
            fileType: /^(image\/(jpeg|png|webp|gif|svg\+xml)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats.*|application\/zip|application\/msword|application\/vnd\.ms-excel)$/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const original = await this.fileService.getById(parentFileId);
    if (!original.projectId) {
      throw new ForbiddenException('Solo se pueden versionar documentos del proyecto');
    }
    const allowed = await this.filePermissions.canManageProjectDocument(user.id, original.projectId);
    if (!allowed) {
      throw new ForbiddenException('Sin permiso para subir versiones');
    }
    return this.fileService.createVersion(parentFileId, {
      organizationId: user.organizationId!,
      uploadedById: user.id,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });
  }

  @Get('documents/:fileId/versions')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Listar historial de versiones de un documento' })
  async listDocumentVersions(@Param('fileId') fileId: string) {
    return this.fileService.listVersions(fileId);
  }

  @Delete('documents/:fileId')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Eliminar documento (soft delete, visible para el cliente como "Eliminado")' })
  async softDeleteDocument(
    @Param('fileId') fileId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const file = await this.fileService.getById(fileId);
    if (!file.projectId) {
      throw new ForbiddenException('Este archivo no es un documento del proyecto');
    }
    const allowed = await this.filePermissions.canManageProjectDocument(user.id, file.projectId);
    if (!allowed) {
      throw new ForbiddenException('Sin permiso para eliminar documentos');
    }
    return this.fileService.softDeleteDocument(fileId, user.id);
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
}
