import { IsOptional, IsEnum, IsString, IsInt, Min, Max, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { TaskStatusDto, TaskPriorityDto } from './create-task.dto';

export class TaskFilterDto {
  @ApiPropertyOptional({ enum: TaskStatusDto, isArray: true, description: 'Filtrar por estados' })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @IsEnum(TaskStatusDto, { each: true, message: 'Estado no valido' })
  status?: TaskStatusDto[];

  @ApiPropertyOptional({ enum: TaskPriorityDto, isArray: true, description: 'Filtrar por prioridades' })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @IsEnum(TaskPriorityDto, { each: true, message: 'Prioridad no valida' })
  priority?: TaskPriorityDto[];

  @ApiPropertyOptional({ example: 'cluser123', description: 'Filtrar por usuario asignado' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ example: 'clsprint123', description: 'Filtrar por sprint' })
  @IsOptional()
  @IsString()
  sprintId?: string;

  @ApiPropertyOptional({ example: 'autenticacion', description: 'Buscar en titulo y descripcion' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, default: 1, description: 'Numero de pagina' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, description: 'Elementos por pagina' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ example: '-createdAt', description: 'Campo de ordenamiento (prefijo - para descendente)' })
  @IsOptional()
  @IsString()
  sort?: string;
}
