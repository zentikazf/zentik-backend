import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectRequestDto {
  @ApiProperty({ example: 'App Móvil de Ventas', description: 'Nombre del proyecto solicitado' })
  @IsString()
  @MinLength(3, { message: 'El nombre debe tener al menos 3 caracteres' })
  @MaxLength(200, { message: 'El nombre no puede exceder 200 caracteres' })
  name: string;

  @ApiPropertyOptional({ example: 'Necesitamos una app para que los vendedores registren pedidos', description: 'Descripción del proyecto' })
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'La descripción no puede exceder 5000 caracteres' })
  description?: string;
}
