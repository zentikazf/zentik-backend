import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Tope defensivo del orden de urgencia (hoy son 3 criticidades; Fase 3 suma CRITICAL). */
export const MAX_CRITICALITY_LEVEL = 99;

/**
 * Edición de la presentación/visibilidad de UNA criticidad de la organización
 * (feature #42 — Fase 2). NO crea criticidades: el enum `TicketCriticality` sigue
 * siendo la fuente; esta config solo agrega etiqueta, visibilidad y orden.
 *
 * Todos los campos son opcionales (PATCH parcial). `clientLabel: null` limpia la
 * etiqueta de cara al cliente y vuelve a mostrar el `displayName` interno.
 */
export class UpdateCriticalityConfigDto {
  @ApiPropertyOptional({ example: 'Alta', description: 'Nombre interno (lo ve el equipo)' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(60, { message: 'El nombre no puede exceder 60 caracteres' })
  displayName?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Urgente',
    description: 'Cómo lo ve el cliente en el portal. null (o ausente) usa el nombre interno.',
  })
  @IsOptional() // class-validator saltea la validación con null Y con undefined
  @IsString()
  @MaxLength(60, { message: 'La etiqueta no puede exceder 60 caracteres' })
  clientLabel?: string | null;

  @ApiPropertyOptional({
    description:
      '¿El cliente puede elegir esta criticidad? Si NINGUNA queda visible, el portal ' +
      'no muestra el selector y entra la criticidad por defecto de la organización.',
  })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  @ApiPropertyOptional({ example: 3, description: 'Orden de urgencia (mayor = más urgente)' })
  @IsOptional()
  @IsInt({ message: 'El nivel debe ser un entero' })
  @Min(1, { message: 'El nivel debe ser al menos 1' })
  @Max(MAX_CRITICALITY_LEVEL)
  level?: number;

  @ApiPropertyOptional({
    description: 'Criticidad por defecto de la organización. Es EXCLUYENTE: marcarla desmarca las otras.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
