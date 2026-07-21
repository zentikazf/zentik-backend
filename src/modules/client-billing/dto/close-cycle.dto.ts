import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CloseCycleDto {
  @ApiPropertyOptional({
    description:
      'Corte parcial: fecha ISO absoluta. El cierre estampa solo movimientos con createdAt <= until. Omitir para cerrar el mes completo.',
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
