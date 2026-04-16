import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePasswordDto {
  @ApiProperty({ description: 'Contraseña actual para verificación' })
  @IsString({ message: 'La contraseña actual es requerida' })
  currentPassword: string;

  @ApiProperty({ description: 'Nueva contraseña', minLength: 8 })
  @IsString({ message: 'La contraseña debe ser un texto' })
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  newPassword: string;
}
