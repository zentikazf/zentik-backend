import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsDateString,
  IsNumber,
  IsBoolean,
  IsArray,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TaskStatusDto {
  BACKLOG = 'BACKLOG',
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

export enum TaskPriorityDto {
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export class CreateTaskDto {
  @ApiProperty({ example: 'Implementar autenticacion', description: 'Titulo de la tarea' })
  @IsString({ message: 'El titulo es requerido' })
  @MinLength(1, { message: 'El titulo no puede estar vacio' })
  @MaxLength(200, { message: 'El titulo no puede exceder 200 caracteres' })
  title: string;

  @ApiPropertyOptional({ example: 'Implementar login con OAuth2', description: 'Descripcion detallada de la tarea' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'La descripcion no puede exceder 5000 caracteres' })
  description?: string;

  @ApiPropertyOptional({ enum: TaskStatusDto, default: TaskStatusDto.BACKLOG, description: 'Estado de la tarea' })
  @IsOptional()
  @IsEnum(TaskStatusDto, { message: 'El estado no es valido' })
  status?: TaskStatusDto;

  @ApiPropertyOptional({ enum: TaskPriorityDto, default: TaskPriorityDto.MEDIUM, description: 'Prioridad de la tarea' })
  @IsOptional()
  @IsEnum(TaskPriorityDto, { message: 'La prioridad no es valida' })
  priority?: TaskPriorityDto;

  @ApiPropertyOptional({ example: 5, description: 'Puntos de historia (story points)' })
  @IsOptional()
  @IsInt({ message: 'Los story points deben ser un numero entero' })
  @Min(0, { message: 'Los story points no pueden ser negativos' })
  @Max(100, { message: 'Los story points no pueden exceder 100' })
  storyPoints?: number;

  @ApiPropertyOptional({ example: '2026-04-15T00:00:00.000Z', description: 'Fecha limite' })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha limite debe tener formato ISO 8601' })
  dueDate?: string;

  @ApiPropertyOptional({ example: '2026-03-15T00:00:00.000Z', description: 'Fecha de inicio' })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio debe tener formato ISO 8601' })
  startDate?: string;

  @ApiPropertyOptional({ example: 8, description: 'Horas estimadas' })
  @IsOptional()
  @IsNumber({}, { message: 'Las horas estimadas deben ser un numero' })
  @Min(0, { message: 'Las horas estimadas no pueden ser negativas' })
  @Max(9999, { message: 'Las horas estimadas no pueden exceder 9999' })
  estimatedHours?: number;

  @ApiPropertyOptional({ example: 150000, description: 'Tarifa por hora de la tarea en guaranies (PYG)' })
  @IsOptional()
  @IsNumber({}, { message: 'La tarifa por hora debe ser un numero' })
  @Min(0, { message: 'La tarifa por hora no puede ser negativa' })
  hourlyRate?: number;

  @ApiPropertyOptional({ example: 'clxyz123', description: 'ID de la columna del tablero' })
  @IsOptional()
  @IsString()
  boardColumnId?: string;

  @ApiPropertyOptional({ example: 'clxyz456', description: 'ID del sprint' })
  @IsOptional()
  @IsString()
  sprintId?: string;

  @ApiPropertyOptional({ example: ['cluser1', 'cluser2'], description: 'IDs de los usuarios asignados', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assigneeIds?: string[];

  @ApiPropertyOptional({ example: ['cllabel1'], description: 'IDs de las etiquetas', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  @ApiPropertyOptional({ description: 'ID del rol destino para esta tarea' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ example: false, description: 'Visible para el cliente en el portal' })
  @IsOptional()
  @IsBoolean({ message: 'clientVisible debe ser un booleano' })
  clientVisible?: boolean;
}
