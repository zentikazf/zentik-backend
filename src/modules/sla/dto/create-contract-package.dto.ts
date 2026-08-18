import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Alta de un paquete de contratos (#58 R3).
 *
 * Nace VACÍO a propósito (R3.3): el flujo real es "creo el paquete, después lo
 * lleno con el editor de árbol". Los ítems entran por el PUT dedicado.
 */
export class CreateContractPackageDto {
  @ApiProperty({
    example: 'Soporte estándar',
    description: 'Nombre único del paquete dentro de la organización',
  })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiPropertyOptional({
    example: 'El default para clientes de mantenimiento mensual',
    description: 'Nota interna: para qué sirve este paquete',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La nota no puede exceder 500 caracteres' })
  notes?: string;
}
