import { IsString, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBudgetItemDto {
  @ApiProperty({ description: 'Descripción del item' })
  @IsString({ message: 'La descripción es requerida' })
  description: string;

  @ApiPropertyOptional({ description: 'Categoría del item' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Horas estimadas' })
  @IsOptional()
  @IsNumber({}, { message: 'Las horas deben ser un número' })
  @Min(0)
  hours?: number;

  @ApiPropertyOptional({ description: 'Tarifa por hora' })
  @IsOptional()
  @IsNumber({}, { message: 'La tarifa debe ser un número' })
  @Min(0)
  hourlyRate?: number;
}

export class UpdateBudgetItemDto {
  @ApiPropertyOptional({ description: 'Descripción del item' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Categoría del item' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Horas estimadas' })
  @IsOptional()
  @IsNumber({}, { message: 'Las horas deben ser un número' })
  @Min(0)
  hours?: number;

  @ApiPropertyOptional({ description: 'Tarifa por hora' })
  @IsOptional()
  @IsNumber({}, { message: 'La tarifa debe ser un número' })
  @Min(0)
  hourlyRate?: number;
}
