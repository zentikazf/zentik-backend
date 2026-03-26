import { IsString, IsOptional, IsEnum, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SuggestionPriority } from '@prisma/client';

export class CreateSuggestionDto {
  @ApiProperty({ example: 'Agregar filtros avanzados', description: 'Título de la sugerencia' })
  @IsString()
  @MinLength(3, { message: 'El título debe tener al menos 3 caracteres' })
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'Descripción detallada de la sugerencia' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: SuggestionPriority, description: 'Prioridad de la sugerencia' })
  @IsOptional()
  @IsEnum(SuggestionPriority)
  priority?: SuggestionPriority;
}
