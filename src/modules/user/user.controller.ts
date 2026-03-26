import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserService } from './user.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Obtener perfil del usuario actual',
    description: 'Retorna el perfil completo del usuario autenticado, incluyendo sus organizaciones.',
  })
  @ApiResponse({ status: 200, description: 'Perfil del usuario obtenido exitosamente' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async getMyProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.userService.getProfile(user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Actualizar perfil del usuario actual',
    description: 'Actualiza el nombre y/o imagen de perfil del usuario autenticado.',
  })
  @ApiResponse({ status: 200, description: 'Perfil actualizado exitosamente' })
  @ApiResponse({ status: 400, description: 'No se proporcionaron campos para actualizar' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async updateMyProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.userService.updateProfile(user.id, dto);
  }

  @Patch('me/avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir avatar del usuario actual',
    description: 'Sube una imagen de perfil. Formatos aceptados: JPEG, PNG, WebP, GIF. Maximo 5MB.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
          description: 'Archivo de imagen (JPEG, PNG, WebP o GIF, maximo 5MB)',
        },
      },
      required: ['avatar'],
    },
  })
  @ApiResponse({ status: 200, description: 'Avatar actualizado exitosamente' })
  @ApiResponse({ status: 400, description: 'Formato o tamano de imagen invalido' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async uploadAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp|gif)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.userService.uploadAvatar(
      user.id,
      file.buffer,
      file.mimetype,
      file.originalname,
    );
  }

  @Get('me/preferences')
  @ApiOperation({
    summary: 'Obtener preferencias del usuario actual',
    description: 'Retorna las preferencias de idioma, tema, zona horaria y notificaciones.',
  })
  @ApiResponse({ status: 200, description: 'Preferencias obtenidas exitosamente' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  async getMyPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.userService.getPreferences(user.id);
  }

  @Patch('me/preferences')
  @ApiOperation({
    summary: 'Actualizar preferencias del usuario actual',
    description: 'Actualiza las preferencias del usuario (idioma, tema, notificaciones, etc.).',
  })
  @ApiResponse({ status: 200, description: 'Preferencias actualizadas exitosamente' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 422, description: 'Datos de entrada invalidos' })
  async updateMyPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.userService.updatePreferences(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obtener usuario por ID',
    description: 'Retorna informacion publica de un usuario por su ID.',
  })
  @ApiParam({ name: 'id', description: 'ID del usuario' })
  @ApiResponse({ status: 200, description: 'Usuario encontrado' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  async getUserById(@Param('id') id: string) {
    return this.userService.getUserById(id);
  }
}
