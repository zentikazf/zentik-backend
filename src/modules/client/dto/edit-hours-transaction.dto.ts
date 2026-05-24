import { IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EditHoursTransactionDto {
  @ApiPropertyOptional({ example: 5.5, description: 'Nuevas horas (debe ser > 0)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Las horas deben ser un numero' })
  @Min(0.01, { message: 'Las horas deben ser mayores a 0' })
  hours?: number;

  @ApiPropertyOptional({
    example: 250000,
    nullable: true,
    description: 'Nueva tarifa por hora. null o 0 para limpiar tarifa.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({}, { message: 'La tarifa debe ser un numero' })
  @Min(0, { message: 'La tarifa no puede ser negativa' })
  priceRate?: number | null;
}
