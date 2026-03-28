import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsDateString,
  IsEmail,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectStatus, AlcanceStatus } from '@prisma/client';

export class CreateProjectDto {
  @ApiProperty({
    example: 'Rediseno Web Corporativa',
    description: 'Nombre del proyecto',
    minLength: 2,
    maxLength: 150,
  })
  @IsString({ message: 'El nombre del proyecto es requerido' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(150, { message: 'El nombre no puede exceder 150 caracteres' })
  name: string;

  @ApiPropertyOptional({
    example: 'Rediseno completo del sitio web corporativo con enfoque mobile-first',
    description: 'Descripcion del proyecto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'La descripcion no puede exceder 2000 caracteres' })
  description?: string;

  @ApiPropertyOptional({
    example: 'DEVELOPMENT',
    description: 'Estado del proyecto',
    enum: ProjectStatus,
  })
  @IsOptional()
  @IsEnum(ProjectStatus, { message: 'El estado del proyecto no es valido' })
  status?: ProjectStatus;

  @ApiPropertyOptional({
    example: 85.0,
    description: 'Tarifa por hora del proyecto',
  })
  @IsOptional()
  @IsNumber({}, { message: 'La tarifa por hora debe ser un numero' })
  @Min(0, { message: 'La tarifa por hora no puede ser negativa' })
  hourlyRate?: number;

  @ApiPropertyOptional({
    example: 120,
    description: 'Horas de desarrollo estimadas para el proyecto',
  })
  @IsOptional()
  @IsNumber({}, { message: 'Las horas estimadas deben ser un numero' })
  @Min(0, { message: 'Las horas estimadas no pueden ser negativas' })
  estimatedHours?: number;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'Moneda para la facturacion del proyecto',
  })
  @IsOptional()
  @IsString()
  @MaxLength(3, { message: 'El codigo de moneda debe tener maximo 3 caracteres' })
  currency?: string;

  @ApiPropertyOptional({
    example: '2026-03-01T00:00:00.000Z',
    description: 'Fecha de inicio del proyecto',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de inicio no es valida' })
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-06-30T00:00:00.000Z',
    description: 'Fecha de fin estimada del proyecto',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de fin no es valida' })
  endDate?: string;

  @ApiPropertyOptional({
    example: 'Acme Corp',
    description: 'Nombre del cliente',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150, { message: 'El nombre del cliente no puede exceder 150 caracteres' })
  clientName?: string;

  @ApiPropertyOptional({
    example: 'contacto@acme.com',
    description: 'Correo electronico del cliente',
  })
  @IsOptional()
  @IsEmail({}, { message: 'El correo electronico del cliente no es valido' })
  clientEmail?: string;

  @ApiPropertyOptional({ description: 'ID del cliente asociado' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ example: 31200000, description: 'Presupuesto del proyecto (PYG)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;

  @ApiPropertyOptional({ example: 15000000, description: 'Inversion del proyecto (PYG)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  investment?: number;

  @ApiPropertyOptional({ example: '2026-04', description: 'Mes de cobro (YYYY-MM)' })
  @IsOptional()
  @IsString()
  billingMonth?: string;

  @ApiPropertyOptional({ description: 'ID del responsable del proyecto' })
  @IsOptional()
  @IsString()
  responsibleId?: string;

  @ApiPropertyOptional({ description: 'Estado del alcance del proyecto', enum: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] })
  @IsOptional()
  @IsEnum(AlcanceStatus, { message: 'El estado del alcance no es válido' })
  alcanceStatus?: AlcanceStatus;

  @ApiPropertyOptional({ description: 'ID del archivo de alcance' })
  @IsOptional()
  @IsString()
  alcanceFileId?: string;
}
