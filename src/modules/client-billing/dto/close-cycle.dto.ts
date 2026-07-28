import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CloseCycleDto {
  @ApiPropertyOptional({
    description: 'Tipo de factura. MES = un mes nominal. ACUMULADO = varios meses elegidos a mano.',
    enum: ['MES', 'ACUMULADO'],
    default: 'MES',
  })
  @IsOptional()
  @IsIn(['MES', 'ACUMULADO'])
  mode?: 'MES' | 'ACUMULADO';

  @ApiPropertyOptional({
    description: 'Mes nominal YYYY-MM (requerido si mode=MES; en la ruta legacy :period/close viaja por path).',
    example: '2026-07',
  })
  @IsOptional()
  @IsString()
  period?: string;

  @ApiPropertyOptional({
    description: 'Meses elegidos YYYY-MM (requerido si mode=ACUMULADO). Ej: ["2026-04","2026-05"].',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  months?: string[];

  @ApiPropertyOptional({
    description:
      'Corte parcial: fecha ISO absoluta. El cierre estampa solo movimientos con FECHA DE TRABAJO (worked_on) <= la fecha-calendario Asunción de until. Omitir para cerrar el mes/rango completo.',
    example: '2026-07-15T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  until?: string;

  @ApiPropertyOptional({ description: 'Notas de la factura', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
