import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO para editar metadata de un documento (project doc o client doc).
 * Si ademas se sube un nuevo archivo, viene como multipart `file` aparte.
 */
export class EditDocumentDto {
  @ApiPropertyOptional({ description: 'Nuevo titulo del documento' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'Nueva descripcion / nota' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

/**
 * DTO para subir un nuevo client document (multipart/form-data).
 * El archivo va como `file`, los campos como query params o body.
 */
export class CreateClientDocumentDto {
  @ApiPropertyOptional({ description: 'Titulo (default: nombre del archivo)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Descripcion / nota opcional' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Si se comparte con el cliente desde el inicio (default: false)' })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;
}
