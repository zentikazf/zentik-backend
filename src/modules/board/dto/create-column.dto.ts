import { IsString, IsInt, IsOptional, IsEnum, MinLength, MaxLength, Min, Max, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@prisma/client';

export class CreateColumnDto {
  @ApiProperty({ example: 'En Progreso', description: 'Nombre de la columna' })
  @IsString({ message: 'El nombre es requerido' })
  @MinLength(1, { message: 'El nombre no puede estar vacio' })
  @MaxLength(50, { message: 'El nombre no puede exceder 50 caracteres' })
  name: string;

  @ApiProperty({ example: 0, description: 'Posicion de la columna en el tablero' })
  @IsInt({ message: 'La posicion debe ser un numero entero' })
  @Min(0, { message: 'La posicion no puede ser negativa' })
  position: number;

  @ApiPropertyOptional({ example: '#3B82F6', description: 'Color de la columna en formato hexadecimal' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'El color debe tener formato hexadecimal (#RRGGBB)' })
  color?: string;

  @ApiPropertyOptional({ example: 5, description: 'Limite de tareas en progreso (WIP limit)' })
  @IsOptional()
  @IsInt({ message: 'El limite WIP debe ser un numero entero' })
  @Min(1, { message: 'El limite WIP debe ser al menos 1' })
  @Max(100, { message: 'El limite WIP no puede exceder 100' })
  wipLimit?: number;

  @ApiPropertyOptional({ enum: TaskStatus, description: 'Estado de tarea mapeado a esta columna' })
  @IsOptional()
  @IsEnum(TaskStatus, { message: 'El estado mapeado debe ser un TaskStatus valido' })
  mappedStatus?: TaskStatus;
}

