import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * Convierte un valor que viene de query string en array. Acepta:
 * - undefined / null -> queda igual (campo opcional).
 * - string suelto (?category=X) -> [X]. Patron mas comun del frontend.
 * - array (?category=X&category=Y) -> sin cambios.
 * Sin esto, el frontend que serializa category como string simple choca con
 * @IsArray() y devuelve 400 BAD_REQUEST silencioso.
 */
const toArray = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null
    ? value
    : Array.isArray(value)
    ? value
    : [value];
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategory, TicketCriticality } from '@prisma/client';
import { TicketStatusDto } from './update-ticket.dto';

/**
 * Campos por los que se puede ordenar el listing.
 * - createdAt: default historico (fecha de creacion DESC).
 * - resolvedAt: usado en tab Resueltos para los mas recientes primero.
 * - priority: orden lexicografico del enum (HIGH antes que MEDIUM antes que LOW).
 * - overshoot: cuanto se paso del SLA — proxy con resolutionDeadline DESC + resolvedAt
 *   en el helper buildOrderBy del service.
 */
export enum TicketSortBy {
  CREATED_AT = 'createdAt',
  RESOLVED_AT = 'resolvedAt',
  PRIORITY = 'priority',
  OVERSHOOT = 'overshoot',
}

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
  @Transform(toArray)
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
  @Transform(toArray)
  @IsArray()
  @IsEnum(TicketCategory, { each: true, message: 'category contiene un valor invalido' })
  category?: TicketCategory[];

  @ApiPropertyOptional({
    enum: TicketSortBy,
    description: 'Campo por el cual ordenar (default createdAt en DESC)',
  })
  @IsOptional()
  @IsEnum(TicketSortBy, { message: 'sortBy invalido' })
  sortBy?: TicketSortBy;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: 'Orden ascendente o descendente (default desc)',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'sortOrder debe ser asc o desc' })
  sortOrder?: 'asc' | 'desc';
}
