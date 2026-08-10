import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Una fila de la matriz tipo → política del proyecto. */
export class ProjectContractItemDto {
  @ApiProperty({ description: 'ID del tipo de solicitud' })
  @IsString()
  ticketTypeId: string;

  /**
   * OBLIGATORIA salvo cuando la fila viene a DESCONTRATAR (`isActive: false`).
   *
   * Antes era obligatoria siempre, y descontratar es justo el caso donde el
   * llamador no tiene por qué saber con qué política se atendía: el front tenía
   * que reenviar la vigente solo para poder apagar la fila, y si no la tenía a
   * mano el PUT moría con un `SLA_POLICY_NOT_FOUND` que no describía nada de lo
   * que estaba pasando (#48 R5.7 / T1).
   *
   * `@ValidateIf` gobierna TODA la propiedad: con `isActive: false` no se valida
   * nada, con cualquier otra cosa se exige el string.
   */
  @ApiPropertyOptional({
    description:
      'ID de la política SLA que se aplica a ese tipo en este proyecto. Obligatoria salvo con isActive: false.',
  })
  @ValidateIf((o) => o.isActive !== false)
  @IsString()
  slaPolicyId?: string;

  @ApiPropertyOptional({ description: 'Nota del contrato comercial (referencia interna)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  contractNotes?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'false desactiva el contrato sin borrarlo (la cascada lo ignora). No exige slaPolicyId.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * ⚠️ SEMÁNTICA (#48 T1): es un upsert de las filas ENVIADAS, no un reemplazo de
 * la matriz. Lo que no viaja en `items` **queda intacto** — no se desactiva ni se
 * borra. Para descontratar hay que mandar la fila con `isActive: false`.
 *
 * Se documenta acá porque durante #42 el frontend asumió lo contrario (que
 * omitir una fila la apagaba) y llegó a comentarlo en el código: el resultado
 * habría sido un check apagado en el admin con el contrato vivo en la base.
 */
export class UpsertProjectContractDto {
  @ApiProperty({ type: [ProjectContractItemDto], description: 'Filas a persistir (upsert por tipo; lo omitido no se toca)' })
  @IsArray()
  @ArrayMaxSize(200, { message: 'No se pueden enviar más de 200 contratos por request' })
  @ValidateNested({ each: true })
  @Type(() => ProjectContractItemDto)
  items: ProjectContractItemDto[];
}
