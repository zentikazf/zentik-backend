import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMemberDto {
  @ApiProperty({ example: 'Juan Pérez', description: 'Nombre completo del usuario' })
  @IsString({ message: 'El nombre es requerido' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  name: string;

  @ApiProperty({ example: 'juan@empresa.com', description: 'Correo electrónico del usuario' })
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email: string;

  @ApiProperty({ example: 'clxxxxxxxxxxxxxxxxx', description: 'ID del rol a asignar' })
  @IsString({ message: 'El ID del rol es requerido' })
  roleId: string;

  @ApiPropertyOptional({ example: 'TempPass123!', description: 'Contraseña temporal (se genera automáticamente si no se provee)' })
  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  password?: string;
}
