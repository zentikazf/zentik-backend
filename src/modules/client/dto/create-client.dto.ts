import {
  IsString,
  IsOptional,
  MinLength,
  MaxLength,
  IsEmail,
  IsNumber,
  Min,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClientDto {
  @ApiProperty({ example: 'ACME Corp', minLength: 2, maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ example: 'contacto@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+595 21 123456' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'Cliente preferencial' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 250000, description: 'Tarifa por hora para tareas de desarrollo (PROJECT)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  developmentHourlyRate?: number;

  @ApiPropertyOptional({ example: 300000, description: 'Tarifa por hora para tareas de soporte/tickets (SUPPORT)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  supportHourlyRate?: number;

  @ApiPropertyOptional({ example: 'PYG', enum: ['PYG', 'USD', 'EUR'] })
  @IsOptional()
  @IsString()
  @IsIn(['PYG', 'USD', 'EUR'])
  currency?: string;
}
