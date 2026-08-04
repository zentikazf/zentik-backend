import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
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
const toArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value;
  // El frontend serializa los facets multi-select como CSV (`?criticality=HIGH,LOW`,
  // ver buildBackendQuery en use-tickets-filters.ts). Envolver el string entero en un
  // array dejaba `["HIGH,LOW"]` — un único valor que `@IsEnum(..., { each: true })`
  // rechaza → 400 en el listado apenas se marcaba una segunda casilla. Con un solo
  // valor no se notaba, y por eso pasó desapercibido.
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [value];
};
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketCategory, TicketCriticality } from '@prisma/client';
import { TicketStatusDto } from './update-ticket.dto';

/**
 * Campos por los que se puede ordenar el listing.
 * - createdAt: default historico (fecha de creacion DESC).
 * - resolvedAt: usado en tab Resueltos para los mas recientes primero.
 * - priority: orden lexicografico del enum (HIGH antes que MEDIUM antes que LOW).
 * - overshoot: cuanto se paso del SLA — ordena por la columna generada
 *   overshootMinutes (feature #12) directamente en buildOrderBy del service.
 */
export enum TicketSortBy {
  CREATED_AT = 'createdAt',
  RESOLVED_AT = 'resolvedAt',
  PRIORITY = 'priority',
  OVERSHOOT = 'overshoot',
}

/**
 * Buckets de overshoot que el frontend envia (?overshootBucket=...). Se traducen
 * a un rango [gte, lt) de minutos sobre la columna generada overshoot_minutes
 * (feature #12). Reemplaza el filtro en memoria previo (filterByOvershoot).
 */
export enum OvershootBucket {
  LT_1H = 'LT_1H',
  BETWEEN_1_4H = 'BETWEEN_1_4H',
  BETWEEN_4_24H = 'BETWEEN_4_24H',
  GT_24H = 'GT_24H',
}

/** Rango [gte, lt?) en minutos asociado a cada bucket. */
const OVERSHOOT_BUCKET_RANGES: Record<OvershootBucket, { gte: number; lt?: number }> = {
  [OvershootBucket.LT_1H]: { gte: 0, lt: 60 },
  [OvershootBucket.BETWEEN_1_4H]: { gte: 60, lt: 240 },
  [OvershootBucket.BETWEEN_4_24H]: { gte: 240, lt: 1440 },
  [OvershootBucket.GT_24H]: { gte: 1440 },
};

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

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description: 'Numero de pagina (paginacion offset, feature #12). 1-based.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

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

  /**
   * El panel "Más filtros" ya tenía selector de proyecto y mandaba `projectId`, pero
   * el DTO no lo declaraba: con `forbidNonWhitelisted: true` (main.ts) eso NO se
   * ignoraba, tiraba **400** y volteaba el listado entero. Peor: el filtro se
   * persiste en cookie 30 días, así que el 400 sobrevivía al refresh.
   */
  @ApiPropertyOptional({ description: 'Filtrar por proyecto' })
  @IsOptional()
  @IsString()
  projectId?: string;

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

  /**
   * El panel de filtros permite marcar VARIOS desenlaces, y los manda como CSV
   * (`slaOutcome=COMPLIED,NO_SLA`). Antes esto era un valor único: dos marcados
   * reventaban el listado con 400 — y el filtro queda guardado en cookie 30 días,
   * así que el error se volvía pegajoso.
   */
  @ApiPropertyOptional({
    isArray: true,
    enum: SlaOutcome,
    description: 'Filtrar por uno o varios desenlaces SLA',
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(SlaOutcome, { each: true, message: 'slaOutcome no es valido' })
  slaOutcome?: SlaOutcome[];

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

  /**
   * Bucket de overshoot que envia el frontend (?overshootBucket=LT_1H...). Se
   * traduce a un rango [gte, lt) de minutos sobre la columna generada
   * overshoot_minutes (feature #12) via los getters overshootMinGte/overshootMaxLt
   * que consume el service. Antes (feature #10) este filtro se ignoraba en backend
   * y el calculo se hacia en memoria (filterByOvershoot, ya eliminado).
   */
  @ApiPropertyOptional({ enum: OvershootBucket, description: 'Filtrar por rango de overshoot' })
  @IsOptional()
  @IsEnum(OvershootBucket, { message: 'overshootBucket no es valido' })
  overshootBucket?: OvershootBucket;

  /** Minutos minimos de overshoot (inclusivo). Derivado de overshootBucket. */
  get overshootMinGte(): number | undefined {
    return this.overshootBucket ? OVERSHOOT_BUCKET_RANGES[this.overshootBucket].gte : undefined;
  }

  /** Cota superior exclusiva de overshoot en minutos. Derivado de overshootBucket. */
  get overshootMaxLt(): number | undefined {
    return this.overshootBucket ? OVERSHOOT_BUCKET_RANGES[this.overshootBucket].lt : undefined;
  }

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
