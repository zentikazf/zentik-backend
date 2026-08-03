import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Criticidad de la política. Espeja el enum `TicketCriticality` de Prisma; se
 * declara local al módulo `sla` para no acoplar los DTOs al módulo `ticket`
 * (Fase 3 convierte la criticidad en catálogo y este enum desaparece).
 */
export enum SlaCriticalityDto {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

/** Tope defensivo de horas (1 año hábil aprox.) — evita deadlines absurdos por typo. */
export const MAX_SLA_HOURS = 8760;

export class CreateSlaPolicyDto {
  @ApiProperty({ example: 'Crítico 24/7', description: 'Nombre único de la política dentro de la organización' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiProperty({ enum: SlaCriticalityDto, description: 'Criticidad a la que pertenece la política' })
  @IsEnum(SlaCriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality: SlaCriticalityDto;

  @ApiProperty({ example: 1, description: 'Horas hábiles para la primera respuesta' })
  @IsInt({ message: 'Las horas de primera respuesta deben ser un entero' })
  @Min(1, { message: 'Las horas de primera respuesta deben ser al menos 1' })
  @Max(MAX_SLA_HOURS)
  firstResponseHours: number;

  @ApiProperty({ example: 4, description: 'Horas hábiles para la resolución' })
  @IsInt({ message: 'Las horas de resolución deben ser un entero' })
  @Min(1, { message: 'Las horas de resolución deben ser al menos 1' })
  @Max(MAX_SLA_HOURS)
  resolutionHours: number;

  @ApiPropertyOptional({ default: false, description: 'Si el reloj se pausa en estados de espera (Fase 2)' })
  @IsOptional()
  @IsBoolean()
  pausesOnWaiting?: boolean;
}
