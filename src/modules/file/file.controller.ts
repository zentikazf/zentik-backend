import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Res,
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
import { StorageService } from '../../infrastructure/storage/storage.service';

@ApiTags('Files')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class FileController {
  constructor(
    private readonly fileService: FileService,
    private readonly storage: StorageService,
  ) {}

  @Post('files/upload')
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
    @Query('category') category?: 'ATTACHMENT' | 'AVATAR' | 'LOGO' | 'DOCUMENT' | 'IMAGE' | 'OTHER',
  ) {
    return this.fileService.upload({
      organizationId: user.organizationId!,
      uploadedById: user.id,
      taskId,
      messageId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      category,
    });
  }

  @Get('files/:id')
  @ApiOperation({ summary: 'Obtener metadatos del archivo' })
  async getById(@Param('id') id: string) {
    return this.fileService.getById(id);
  }

  @Get('files/:id/download')
  @ApiOperation({ summary: 'Obtener URL de descarga firmada' })
  async download(@Param('id') id: string) {
    const url = await this.fileService.getDownloadUrl(id);
    return { url };
  }

  @Delete('files/:id')
  @ApiOperation({ summary: 'Eliminar un archivo' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.fileService.delete(id, user.id);
  }

  @Get('projects/:projectId/files')
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

  @Get('files/serve/:key(*)')
  @ApiOperation({ summary: 'Servir archivo desde disco local' })
  async serveFile(@Param('key') key: string, @Res() res: Response) {
    const filePath = this.storage.getFilePath(key);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException('Archivo no encontrado');
    }

    const file = await this.fileService.getByKey(key);
    res.setHeader('Content-Type', file?.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file?.originalName || 'file'}"`);
    res.sendFile(filePath);
  }
}
