import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateTicketTypeDto {
  @ApiPropertyOptional({ example: 'Incidencia' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @ApiPropertyOptional({
    example: 'incidencia',
    description: 'Slug único. Si NO se envía, el slug actual se conserva aunque cambie el nombre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'El slug solo admite minúsculas, números y guiones',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Reactivar/desactivar el tipo' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // #42 Fase 3 (árbol). Semántica de tres estados, a propósito:
  //   · ausente   → el tipo NO se mueve
  //   · null      → se mueve a raíz
  //   · "id"      → se mueve bajo ese padre
  // `path`/`level` NO se aceptan del cliente (derivados; el ValidationPipe global
  // corre con `forbidNonWhitelisted: true` y los rechaza con 400).
  @ApiPropertyOptional({
    description: 'Mover el tipo: id del nuevo padre, o null para moverlo a raíz. Si no se envía, no se mueve.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  /**
   * El "ojito" (#48 R1/R5.8). Es un campo del TIPO, **global a la organización**:
   * no es por proyecto. Apagarlo es una acción de PRESENTACIÓN — no toca los
   * contratos ni la cascada, y un padre oculto con contrato sigue resolviendo
   * (#48 R6). No cascadea a los hijos: cada nodo tiene el suyo.
   */
  @ApiPropertyOptional({
    description:
      'Si el tipo se ofrece como opción al cliente. false = carpeta pura (no cascadea a los hijos).',
  })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}
