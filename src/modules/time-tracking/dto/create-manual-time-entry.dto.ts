import {
  IsInt,
  Min,
  Max,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * H4 — Carga manual de horas: la hora nace de una DECLARACIÓN HUMANA con fecha real (`workedOn`).
 * Distinto de `CreateTimeEntryDto` (vía timer: exige startTime/endTime y calcula duration en segundos).
 */
export class CreateManualTimeEntryDto {
  @ApiProperty({ example: 90, description: 'Horas reales trabajadas, EN MINUTOS' })
  @IsInt({ message: 'Los minutos deben ser un número entero' })
  @Min(1, { message: 'La carga debe ser de al menos 1 minuto' })
  @Max(24 * 60, { message: 'Una entrada no puede superar 24 horas (1440 min)' })
  minutes: number;

  @ApiProperty({
    example: '2026-07-20',
    description: 'Fecha real de trabajo (YYYY-MM-DD, date-only)',
  })
  @IsDateString({}, { message: 'workedOn debe ser una fecha válida (YYYY-MM-DD)' })
  workedOn: string;

  @ApiPropertyOptional({
    example: 'Ajuste de SLA en el flujo de tickets',
    description: 'Descripción/nota del trabajo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Solo PM/manage:time-entries: imputar la carga a OTRO usuario (por defecto, el actor)',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
