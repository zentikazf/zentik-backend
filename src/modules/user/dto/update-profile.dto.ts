import { IsString, IsOptional, MinLength, MaxLength, IsUrl } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'John Doe', description: 'Nombre completo del usuario' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'El nombre debe tener al menos 2 caracteres' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/avatars/john.jpg',
    description: 'URL de la imagen de perfil',
  })
  @IsOptional()
  @IsUrl({}, { message: 'La URL de la imagen no es valida' })
  image?: string;
}
