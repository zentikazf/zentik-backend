import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategory, TicketCriticality } from '@prisma/client';
import { TicketStatusDto } from './update-ticket.dto';

/**
 * Resultado SLA del ticket — usado para filtrar el listing en la vista
 * "Resueltos" (feature #10). El backend evalua sobre las flags
 * slaResponseBreached / slaResolutionBreached + presencia de deadlines.
 * NO incluye IN_FLIGHT porque ese estado no aplica a tickets RESOLVED.
 */
export enum SlaOutcome {
  COMPLIED = 'COMPLIED',
  BREACHED_RESPONSE = 'BREACHED_RESPONSE',
  BREACHED_RESOLUTION = 'BREACHED_RESOLUTION',
  BREACHED_BOTH = 'BREACHED_BOTH',
  NO_SLA = 'NO_SLA',
}

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

  // ─── Facets para vista "Resueltos" (feature #10) ─────────────────────

  @ApiPropertyOptional({ enum: SlaOutcome, description: 'Filtrar por desenlace SLA' })
  @IsOptional()
  @IsEnum(SlaOutcome, { message: 'slaOutcome no es valido' })
  slaOutcome?: SlaOutcome;

  @ApiPropertyOptional({
    isArray: true,
    enum: TicketCriticality,
    description: 'Filtrar por uno o varios niveles de criticidad',
  })
  @IsOptional()
  @Type(() => String)
  @IsArray()
  @IsEnum(TicketCriticality, { each: true, message: 'criticality contiene un valor invalido' })
  criticality?: TicketCriticality[];

  @ApiPropertyOptional({ description: 'Minutos minimos de overshoot (sobre resolutionDeadline)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  overshootMinGte?: number;

  @ApiPropertyOptional({ description: 'Fecha desde de resolucion (ISO)' })
  @IsOptional()
  @IsDateString({}, { message: 'resolvedFrom debe ser una fecha ISO valida' })
  resolvedFrom?: string;

  @ApiPropertyOptional({ description: 'Fecha hasta de resolucion (ISO)' })
  @IsOptional()
  @IsDateString({}, { message: 'resolvedTo debe ser una fecha ISO valida' })
  resolvedTo?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: TicketCategory,
    description: 'Filtrar por uno o varios tipos de ticket',
  })
  @IsOptional()
  @Type(() => String)
  @IsArray()
  @IsEnum(TicketCategory, { each: true, message: 'category contiene un valor invalido' })
  category?: TicketCategory[];
}
