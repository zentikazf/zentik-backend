import { IsOptional, IsDateString, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TimeReportFilterDto {
  @ApiPropertyOptional({
    example: '2026-03-01T00:00:00.000Z',
    description: 'Fecha de inicio del reporte',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio debe ser una fecha valida' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-03-31T23:59:59.999Z',
    description: 'Fecha de fin del reporte',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin debe ser una fecha valida' })
  endDate?: string;

  @ApiPropertyOptional({
    example: 'clxyz123abc',
    description: 'ID del proyecto para filtrar',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    example: 'clxyz456def',
    description: 'ID del usuario para filtrar',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
