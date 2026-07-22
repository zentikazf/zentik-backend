import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsString,
  MaxLength,
} from 'class-validator';
import { CreateTimeEntryDto } from './create-time-entry.dto';

/**
 * Actualización de una entrada de tiempo. Conserva la vía legacy (timer: startTime/endTime/duration)
 * heredada de `CreateTimeEntryDto`, y suma la vía de corrección manual (H4): `minutes`/`workedOn`/`note`.
 */
export class UpdateTimeEntryDto extends PartialType(CreateTimeEntryDto) {
  @ApiPropertyOptional({ example: 120, description: 'H4: corrección de los minutos declarados' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  minutes?: number;

  @ApiPropertyOptional({ example: '2026-07-20', description: 'H4: corrección de la fecha de trabajo' })
  @IsOptional()
  @IsDateString()
  workedOn?: string;

  @ApiPropertyOptional({ description: 'H4: nota de la corrección' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
