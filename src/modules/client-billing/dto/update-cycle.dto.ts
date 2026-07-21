import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCycleDto {
  @ApiPropertyOptional({
    description: 'Transición de estado de la factura. Solo DRAFT→SENT y SENT→PAID.',
    enum: ['SENT', 'PAID'],
  })
  @IsOptional()
  @IsIn(['SENT', 'PAID'])
  status?: 'SENT' | 'PAID';

  @ApiPropertyOptional({ description: 'Notas de la factura', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
