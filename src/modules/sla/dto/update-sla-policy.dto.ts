import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { MAX_SLA_HOURS, SlaCriticalityDto } from './create-sla-policy.dto';

export class UpdateSlaPolicyDto {
  @ApiPropertyOptional({ example: 'Crítico 24/7' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @ApiPropertyOptional({ enum: SlaCriticalityDto })
  @IsOptional()
  @IsEnum(SlaCriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality?: SlaCriticalityDto;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt({ message: 'Las horas de primera respuesta deben ser un entero' })
  @Min(1, { message: 'Las horas de primera respuesta deben ser al menos 1' })
  @Max(MAX_SLA_HOURS)
  firstResponseHours?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt({ message: 'Las horas de resolución deben ser un entero' })
  @Min(1, { message: 'Las horas de resolución deben ser al menos 1' })
  @Max(MAX_SLA_HOURS)
  resolutionHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pausesOnWaiting?: boolean;

  @ApiPropertyOptional({ description: 'Reactivar/desactivar la política' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
