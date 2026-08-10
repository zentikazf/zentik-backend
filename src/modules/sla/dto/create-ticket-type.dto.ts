import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateTicketTypeDto {
  @ApiProperty({ example: 'Incidencia', description: 'Nombre del tipo de solicitud' })
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiPropertyOptional({
    example: 'incidencia',
    description: 'Slug único en la organización. Si no viene, se genera del nombre (sin tildes).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'El slug solo admite minúsculas, números y guiones',
  })
  slug?: string;

  // #42 Fase 3 (árbol). `path` y `level` NO están acá a propósito: son DERIVADOS y
  // los calcula el service. Además el ValidationPipe global corre con
  // `forbidNonWhitelisted: true`, así que mandarlos es un 400, no un silencio.
  @ApiPropertyOptional({
    description: 'Id del tipo padre. Ausente o null = tipo raíz. Máximo 3 niveles.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  /**
   * El "ojito" (#48 R1). `false` = carpeta pura: agrupa y ordena, pero el cliente
   * no la ve ni la elige — sus hijos contratados sí se siguen ofreciendo.
   *
   * Ausente = `true` (el default de la columna). Un tipo nuevo nace visible: lo
   * contrario dejaría tipos invisibles sin que nadie lo haya pedido.
   */
  @ApiPropertyOptional({
    default: true,
    description: 'Si el tipo se ofrece como opción al cliente. false = carpeta pura.',
  })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}
