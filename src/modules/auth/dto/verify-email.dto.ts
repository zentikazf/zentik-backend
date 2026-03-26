import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token de verificacion recibido por correo' })
  @IsString({ message: 'El token de verificacion es requerido' })
  token: string;
}
