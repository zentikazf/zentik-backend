import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TicketCriticalityDto } from './create-ticket.dto';

/**
 * Tipificación / reclasificación interna de un ticket (feature #42 — Fase 2).
 *
 * El cliente reporta; el equipo tipifica. Todos los campos de clasificación son
 * opcionales (se manda solo lo que cambia), pero el **motivo es obligatorio**: sin
 * él la reclasificación no deja rastro auditable de POR QUÉ se cambió.
 *
 * ⚠️ Reclasificar NO recalcula los deadlines (decisión de diseño, igual que OSD).
 */
export class ReclassifyTicketDto {
  @ApiPropertyOptional({ description: 'Nuevo tipo de solicitud (debe ser de la organización)' })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'ticketTypeId inválido' })
  ticketTypeId?: string;

  @ApiPropertyOptional({ enum: TicketCriticalityDto, description: 'Nueva criticidad' })
  @IsOptional()
  @IsEnum(TicketCriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality?: TicketCriticalityDto;

  @ApiPropertyOptional({ description: 'Nueva categoría interna (TicketCategoryConfig)' })
  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'categoryConfigId inválido' })
  categoryConfigId?: string;

  @ApiProperty({
    example: 'El cliente lo reportó como consulta pero es un error del sistema',
    description: 'Motivo de la reclasificación. OBLIGATORIO — queda en el timeline.',
  })
  @IsString({ message: 'El motivo de la reclasificación es obligatorio' })
  @MinLength(3, { message: 'El motivo debe tener al menos 3 caracteres' })
  @MaxLength(500, { message: 'El motivo no puede exceder 500 caracteres' })
  reason: string;
}
