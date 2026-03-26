import { IsString, IsOptional, IsDateString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSprintDto {
  @ApiProperty({ example: 'Sprint 1', description: 'Nombre del sprint' })
  @IsString({ message: 'El nombre es requerido' })
  @MinLength(1, { message: 'El nombre no puede estar vacio' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiPropertyOptional({ example: 'Completar la autenticacion y el dashboard', description: 'Objetivo del sprint' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'El objetivo no puede exceder 500 caracteres' })
  goal?: string;

  @ApiPropertyOptional({ example: '2026-03-15T00:00:00.000Z', description: 'Fecha de inicio del sprint' })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio debe tener formato ISO 8601' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-03-29T00:00:00.000Z', description: 'Fecha de fin del sprint' })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin debe tener formato ISO 8601' })
  endDate?: string;
}
