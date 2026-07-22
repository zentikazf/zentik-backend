import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * H4 — Soft delete: motivo opcional del borrado, queda en la traza (`deleteReason` + evento).
 */
export class DeleteTimeEntryDto {
  @ApiPropertyOptional({ description: 'Motivo del borrado (queda registrado en la traza)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
