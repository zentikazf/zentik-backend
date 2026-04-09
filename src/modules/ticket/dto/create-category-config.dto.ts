import { IsString, IsOptional, IsEnum, IsBoolean, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CriticalityDto {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export class CreateCategoryConfigDto {
  @ApiProperty({ example: 'Configuración de flujos' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Tickets relacionados a configuración de flujos' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: CriticalityDto, default: CriticalityDto.MEDIUM })
  @IsEnum(CriticalityDto, { message: 'La criticidad debe ser HIGH, MEDIUM o LOW' })
  criticality: CriticalityDto;
}

export class UpdateCategoryConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: CriticalityDto })
  @IsOptional()
  @IsEnum(CriticalityDto)
  criticality?: CriticalityDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
