import { IsString, IsEnum, IsOptional, MinLength, MaxLength, Matches, ValidateIf } from 'class-validator';
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

/**
 * Criticidad elegible por el cliente (feature #42 — Fase 2). Espeja el enum
 * `TicketCriticality` de Prisma; el servidor valida ADEMAS que esté marcada
 * `clientVisible` en la organización (no alcanza con que el enum la admita).
 */
export enum TicketCriticalityDto {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
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

  /**
   * CONTRATO VIEJO (feature #42 — Fase 2: pasa a OPCIONAL; se deprecia en Fase 3).
   *
   * El form nuevo del portal manda `ticketTypeId` + `criticality` y NO manda
   * `category`. Se sigue aceptando el enum y el prefijo `dynamic:<configId>` para
   * que el front se despliegue sin coordinación exacta y un cliente con la página
   * cacheada no rompa.
   *
   * `@ValidateIf` gobierna TODA la propiedad: con `undefined` o con `dynamic:` no
   * se valida nada (mismo comportamiento que Fase 1); con un valor de enum se exige
   * que sea uno válido.
   */
  @ApiPropertyOptional({
    description:
      'DEPRECADO — categoria del ticket (enum o dynamic:<configId>). Usar ticketTypeId + criticality.',
    deprecated: true,
  })
  @ValidateIf((o) => typeof o.category === 'string' && !o.category.startsWith('dynamic:'))
  @IsString()
  @IsEnum(TicketCategoryDto, { message: 'La categoria no es valida' })
  category?: string;

  @ApiPropertyOptional({ enum: TicketPriorityDto, default: TicketPriorityDto.MEDIUM, description: 'Prioridad del ticket' })
  @IsOptional()
  @IsEnum(TicketPriorityDto, { message: 'La prioridad no es valida' })
  priority?: TicketPriorityDto;

  @ApiPropertyOptional({ description: 'ID del ticket relacionado (follow-up de un ticket previo del mismo cliente)' })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'relatedTicketId inválido' })
  relatedTicketId?: string;

  @ApiPropertyOptional({
    description:
      'Tipo de solicitud elegido por el cliente (feature #42 — Fase 2). Se valida server-side ' +
      'contra los contratos del proyecto y alimenta el paso 1 de la cascada de SLA.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'ticketTypeId inválido' })
  ticketTypeId?: string;

  @ApiPropertyOptional({
    enum: TicketCriticalityDto,
    description:
      'Criticidad elegida por el cliente (feature #42 — Fase 2). Debe estar marcada ' +
      'clientVisible en la organización. Si no viene, entra la criticidad por defecto.',
  })
  @IsOptional()
  @IsEnum(TicketCriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality?: TicketCriticalityDto;
}
