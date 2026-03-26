import { IsDateString, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateInvoiceDto {
  @ApiProperty({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Inicio del periodo de facturacion',
  })
  @IsDateString({}, { message: 'La fecha de inicio del periodo no es valida' })
  periodStart: string;

  @ApiProperty({
    example: '2026-01-31T23:59:59.000Z',
    description: 'Fin del periodo de facturacion',
  })
  @IsDateString({}, { message: 'La fecha de fin del periodo no es valida' })
  periodEnd: string;

  @ApiPropertyOptional({
    example: 'Factura correspondiente al mes de enero',
    description: 'Notas adicionales para la factura',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Las notas no pueden exceder 1000 caracteres' })
  notes?: string;

  @ApiPropertyOptional({
    example: 150000,
    description: 'Tarifa por hora por defecto en guaranies (PYG) para tareas sin tarifa propia',
  })
  @IsOptional()
  @IsNumber({}, { message: 'La tarifa por hora debe ser un numero' })
  @Min(0, { message: 'La tarifa por hora no puede ser negativa' })
  defaultHourlyRate?: number;
}
