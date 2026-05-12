import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ActivateAccountDto {
  @ApiProperty({ description: 'Token de activacion recibido por email' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ description: 'Nueva contrasena definida por el usuario (min 6 chars)' })
  @IsString()
  @MinLength(6, { message: 'La contrasena debe tener al menos 6 caracteres' })
  password!: string;
}
