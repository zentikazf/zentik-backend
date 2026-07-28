import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * H8d: dry-run del conjunto facturable (POST cycles/preview, read:billing). No muta nada.
 * La validación de negocio (period requerido en MES, months en ACUMULADO) la hace el service
 * con mensajes es-PY (PERIOD_REQUIRED / MONTHS_REQUIRED) — el DTO solo valida forma.
 */
export class PreviewCycleDto {
  @ApiPropertyOptional({
    description: 'Tipo de factura. MES = un mes nominal. ACUMULADO = varios meses elegidos a mano.',
    enum: ['MES', 'ACUMULADO'],
    default: 'MES',
  })
  @IsOptional()
  @IsIn(['MES', 'ACUMULADO'])
  mode?: 'MES' | 'ACUMULADO';

  @ApiPropertyOptional({ description: 'Mes nominal YYYY-MM (requerido si mode=MES).', example: '2026-07' })
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
      'Corte parcial por fecha de trabajo (worked_on <= fecha-calendario Asunción de until). En MES clampeado al mes; en ACUMULADO libre dentro de los meses elegidos.',
    example: '2026-07-15T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  until?: string;
}
