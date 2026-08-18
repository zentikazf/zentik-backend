import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { trimmed } from './create-contract-package.dto';

/**
 * PATCH parcial del paquete: renombrar, cambiar la nota o archivarlo.
 *
 * ⚠️ NO toca los ítems — para eso está el PUT dedicado, cuya semántica
 * (destildar BORRA) es incompatible con un patch escalar.
 */
export class UpdateContractPackageDto {
  @ApiPropertyOptional({ description: 'Nombre único del paquete dentro de la organización' })
  @trimmed()
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @ApiPropertyOptional({ description: 'Nota interna. String vacío la limpia.' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La nota no puede exceder 500 caracteres' })
  notes?: string;

  @ApiPropertyOptional({
    description:
      'false archiva el paquete: deja de ofrecerse para aplicar y sus ítems dejan de bloquear la baja de una política.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
