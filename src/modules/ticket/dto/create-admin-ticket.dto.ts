import { IsString, IsEnum, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategoryDto, TicketPriorityDto } from './create-ticket.dto';

export class CreateAdminTicketDto {
  @ApiProperty({ example: 'Error al cargar la factura', description: 'Titulo del ticket' })
  @IsString()
  @MinLength(3, { message: 'El titulo debe tener al menos 3 caracteres' })
  @MaxLength(200, { message: 'El titulo no puede exceder 200 caracteres' })
  title: string;

  @ApiPropertyOptional({ description: 'Descripcion detallada' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'La descripcion no puede exceder 5000 caracteres' })
  description?: string;

  @ApiProperty({ enum: TicketCategoryDto, description: 'Categoria del ticket' })
  @IsEnum(TicketCategoryDto, { message: 'La categoria no es valida' })
  category: TicketCategoryDto;

  @ApiPropertyOptional({ enum: TicketPriorityDto, default: TicketPriorityDto.MEDIUM })
  @IsOptional()
  @IsEnum(TicketPriorityDto, { message: 'La prioridad no es valida' })
  priority?: TicketPriorityDto;

  @ApiProperty({ description: 'ID del cliente' })
  @IsString()
  clientId: string;

  @ApiProperty({ description: 'ID del proyecto' })
  @IsString()
  projectId: string;

  @ApiPropertyOptional({ description: 'ID de la categoría configurable' })
  @IsOptional()
  @IsString()
  categoryConfigId?: string;
}
