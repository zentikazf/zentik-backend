import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { SlaCriticalityDto } from './create-sla-policy.dto';

/**
 * Filtro opcional del selector encadenado del portal (feature #42 — Fase 2):
 * `proyecto → criticidad → tipo`. Con `criticality` solo se devuelven los tipos
 * cuyo contrato apunta a una política de ESA criticidad (así el selector encadena
 * como en OSD). Sin él, todos los tipos contratados del proyecto.
 */
export class AvailableTicketTypesQueryDto {
  @ApiPropertyOptional({ enum: SlaCriticalityDto })
  @IsOptional()
  @IsEnum(SlaCriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality?: SlaCriticalityDto;
}
