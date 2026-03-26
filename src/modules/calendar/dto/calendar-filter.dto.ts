import { IsDateString, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CalendarFilterDto {
  @ApiPropertyOptional({
    example: '2026-03-01T00:00:00.000Z',
    description: 'Fecha de inicio del rango',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio no es valida' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-03-31T23:59:59.000Z',
    description: 'Fecha de fin del rango',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin no es valida' })
  endDate?: string;

  @ApiPropertyOptional({
    example: 'clxyz123abc',
    description: 'Filtrar por proyecto',
  })
  @IsOptional()
  @IsString()
  projectId?: string;
}
