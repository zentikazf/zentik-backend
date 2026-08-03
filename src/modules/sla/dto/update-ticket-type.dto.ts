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
}
