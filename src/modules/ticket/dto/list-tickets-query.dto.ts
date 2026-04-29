import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketStatusDto } from './update-ticket.dto';

export class ListTicketsQueryDto {
  @ApiPropertyOptional({ enum: TicketStatusDto })
  @IsOptional()
  @IsEnum(TicketStatusDto, { message: 'El estado no es valido' })
  status?: TicketStatusDto;

  @ApiPropertyOptional({ description: 'Cursor de paginacion (ID del ultimo ticket de la pagina anterior)' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filtrar por cliente' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Buscar por titulo, ID o ticketNumber' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filtrar por usuario asignado a la task del ticket' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Filtrar por usuario que creo el ticket' })
  @IsOptional()
  @IsString()
  createdByUserId?: string;

  @ApiPropertyOptional({ description: 'Filtrar por configuracion de categoria SLA' })
  @IsOptional()
  @IsString()
  categoryConfigId?: string;
}
