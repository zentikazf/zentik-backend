import { IsString, IsEnum, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum TicketCategoryDto {
  SUPPORT_REQUEST = 'SUPPORT_REQUEST',
  NEW_DEVELOPMENT = 'NEW_DEVELOPMENT',
  NEW_PROJECT = 'NEW_PROJECT',
}

export enum TicketPriorityDto {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export class CreateTicketDto {
  @ApiProperty({ example: 'Error al cargar la factura', description: 'Titulo del ticket' })
  @IsString()
  @MinLength(3, { message: 'El titulo debe tener al menos 3 caracteres' })
  @MaxLength(200, { message: 'El titulo no puede exceder 200 caracteres' })
  title: string;

  @ApiPropertyOptional({ example: 'Al acceder a la seccion de facturas aparece un error 500', description: 'Descripcion detallada' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'La descripcion no puede exceder 5000 caracteres' })
  description?: string;

  @ApiProperty({ enum: TicketCategoryDto, description: 'Categoria del ticket' })
  @IsEnum(TicketCategoryDto, { message: 'La categoria no es valida' })
  category: TicketCategoryDto;

  @ApiPropertyOptional({ enum: TicketPriorityDto, default: TicketPriorityDto.MEDIUM, description: 'Prioridad del ticket' })
  @IsOptional()
  @IsEnum(TicketPriorityDto, { message: 'La prioridad no es valida' })
  priority?: TicketPriorityDto;
}
