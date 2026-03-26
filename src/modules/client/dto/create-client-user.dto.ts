import { IsString, IsEmail, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateClientUserDto {
  @ApiProperty({ example: 'Juan Pérez', description: 'Nombre del usuario cliente' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(150)
  name: string;

  @ApiProperty({ example: 'cliente@empresa.com', description: 'Email del usuario cliente' })
  @IsEmail({}, { message: 'El email no es válido' })
  email: string;

  @ApiProperty({ example: 'SecurePass123', description: 'Contraseña del usuario cliente' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(100)
  password: string;
}
