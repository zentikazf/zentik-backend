import { TicketCriticality } from '@prisma/client';
import { IsString, IsOptional, IsEnum, IsBoolean, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CriticalityDto {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

/**
 * Guard de compilacion — ver la nota extensa en `create-ticket.dto.ts`: este enum
 * espeja a mano `TicketCriticality` de Prisma. La pantalla ya no pide criticidad
 * (#42 Fase 2.1), pero el campo sigue vivo para el path legacy, asi que el espejo
 * tiene que seguir completo.
 */
type _AssertCriticalityDtoCoversPrisma =
  Exclude<TicketCriticality, `${CriticalityDto}`> extends never ? true : never;

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
