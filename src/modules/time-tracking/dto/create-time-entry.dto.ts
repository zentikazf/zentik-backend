import {
  IsString,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimeEntryDto {
  @ApiProperty({
    example: 'clxyz123abc',
    description: 'ID de la tarea asociada',
  })
  @IsString({ message: 'El ID de la tarea es requerido' })
  taskId: string;

  @ApiPropertyOptional({
    example: 'Implementacion del modulo de autenticacion',
    description: 'Descripcion del trabajo realizado',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: '2026-03-14T09:00:00.000Z',
    description: 'Hora de inicio',
  })
  @IsDateString({}, { message: 'La hora de inicio debe ser una fecha valida' })
  startTime: string;

  @ApiProperty({
    example: '2026-03-14T11:30:00.000Z',
    description: 'Hora de fin',
  })
  @IsDateString({}, { message: 'La hora de fin debe ser una fecha valida' })
  endTime: string;

  @ApiPropertyOptional({
    example: 9000,
    description: 'Duracion en segundos (calculada automaticamente si no se proporciona)',
  })
  @IsOptional()
  @IsNumber({}, { message: 'La duracion debe ser un numero' })
  @Min(0, { message: 'La duracion no puede ser negativa' })
  duration?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Indica si la entrada es facturable',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'El campo facturable debe ser verdadero o falso' })
  billable?: boolean;
}
