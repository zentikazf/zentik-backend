import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum ReportPeriod {
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

export class ReportFilterDto {
  @ApiPropertyOptional({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Fecha de inicio del reporte',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio no es valida' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-03-31T23:59:59.000Z',
    description: 'Fecha de fin del reporte',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin no es valida' })
  endDate?: string;

  @ApiPropertyOptional({
    example: 'monthly',
    description: 'Periodo de agrupacion',
    enum: ReportPeriod,
  })
  @IsOptional()
  @IsEnum(ReportPeriod, { message: 'El periodo debe ser weekly o monthly' })
  period?: ReportPeriod;
}
