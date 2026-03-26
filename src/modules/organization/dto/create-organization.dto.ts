import { IsString, IsOptional, IsUrl, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrganizationDto {
  @ApiProperty({
    example: 'Acme Corp',
    description: 'Nombre de la organizacion',
    minLength: 2,
    maxLength: 100,
  })
  @IsString({ message: 'El nombre es requerido' })
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiPropertyOptional({
    example: 'acme-corp',
    description: 'Slug unico para la organizacion (se genera automaticamente si no se proporciona)',
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El slug debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El slug no puede exceder 100 caracteres' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'El slug solo puede contener letras minusculas, numeros y guiones',
  })
  slug?: string;

  @ApiPropertyOptional({
    example: 'Empresa de tecnologia enfocada en soluciones SaaS',
    description: 'Descripcion de la organizacion',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La descripcion no puede exceder 500 caracteres' })
  description?: string;

  @ApiPropertyOptional({
    example: 'https://acme.com',
    description: 'Sitio web de la organizacion',
  })
  @IsOptional()
  @IsUrl({}, { message: 'La URL del sitio web no es valida' })
  website?: string;
}
