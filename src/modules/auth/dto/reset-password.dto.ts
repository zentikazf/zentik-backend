import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token de restablecimiento recibido por correo' })
  @IsString({ message: 'El token es requerido' })
  token: string;

  @ApiProperty({ example: 'NewSecureP@ss123', description: 'Nueva contrasena (minimo 8 caracteres)' })
  @IsString()
  @MinLength(8, { message: 'La contrasena debe tener al menos 8 caracteres' })
  @MaxLength(100, { message: 'La contrasena no puede exceder 100 caracteres' })
  newPassword: string;
}
