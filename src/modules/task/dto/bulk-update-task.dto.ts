import { IsArray, ValidateNested, IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TaskStatusDto, TaskPriorityDto } from './create-task.dto';

export class BulkOperationDto {
  @ApiProperty({ example: 'cltask123', description: 'ID de la tarea' })
  @IsString({ message: 'El ID de la tarea es requerido' })
  taskId: string;

  @ApiPropertyOptional({ enum: TaskStatusDto, description: 'Nuevo estado' })
  @IsOptional()
  @IsEnum(TaskStatusDto, { message: 'Estado no valido' })
  status?: TaskStatusDto;

  @ApiPropertyOptional({ enum: TaskPriorityDto, description: 'Nueva prioridad' })
  @IsOptional()
  @IsEnum(TaskPriorityDto, { message: 'Prioridad no valida' })
  priority?: TaskPriorityDto;

  @ApiPropertyOptional({ example: 'clsprint123', description: 'ID del sprint' })
  @IsOptional()
  @IsString()
  sprintId?: string;

  @ApiPropertyOptional({ example: 'cluser123', description: 'ID del usuario asignado' })
  @IsOptional()
  @IsString()
  assigneeId?: string;
}

export class BulkUpdateTaskDto {
  @ApiProperty({ type: [BulkOperationDto], description: 'Lista de operaciones en lote' })
  @IsArray({ message: 'Se requiere un arreglo de operaciones' })
  @ValidateNested({ each: true })
  @Type(() => BulkOperationDto)
  operations: BulkOperationDto[];
}
