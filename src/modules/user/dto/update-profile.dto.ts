import { IsString, IsOptional, MinLength, MaxLength, IsUrl, IsEmail, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'John Doe', description: 'Nombre completo del usuario' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/avatars/john.jpg',
    description: 'URL de la imagen de perfil',
  })
  @IsOptional()
  @IsUrl({}, { message: 'La URL de la imagen no es valida' })
  image?: string;

  @ApiPropertyOptional({
    example: 'juan.alt@empresa.com',
    description: 'Email alternativo para recibir notificaciones (override del email de login). Enviar string vacio o null para limpiar.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsEmail({}, { message: 'El email de notificaciones no es valido' })
  notificationEmail?: string | null;
}
