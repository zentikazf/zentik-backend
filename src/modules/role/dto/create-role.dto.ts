import {
  IsString,
  IsOptional,
  IsArray,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({
    example: 'Project Manager',
    description: 'Nombre del rol',
    minLength: 2,
    maxLength: 50,
  })
  @IsString({ message: 'El nombre del rol es requerido' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(50, { message: 'El nombre no puede exceder 50 caracteres' })
  name: string;

  @ApiPropertyOptional({
    example: 'Responsable de la gestion de proyectos y equipos',
    description: 'Descripcion del rol',
  })
  @IsOptional()
  @IsString()
  @MaxLength(250, { message: 'La descripcion no puede exceder 250 caracteres' })
  description?: string;

  @ApiPropertyOptional({
    example: ['clxxxxxxxxx1', 'clxxxxxxxxx2'],
    description: 'IDs de los permisos a asignar al rol',
    type: [String],
  })
  @IsOptional()
  @IsArray({ message: 'Los permisos deben ser un arreglo' })
  @IsString({ each: true, message: 'Cada permiso debe ser un ID valido' })
  permissions?: string[];
}
