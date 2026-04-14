import { IsString, MinLength, MaxLength, IsOptional, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty({
    example: 'Hola equipo, el deploy se hizo correctamente',
    description: 'Contenido del mensaje',
  })
  @IsString({ message: 'El contenido del mensaje es requerido' })
  @MinLength(1, { message: 'El mensaje no puede estar vacio' })
  @MaxLength(5000, { message: 'El mensaje no puede exceder 5000 caracteres' })
  content: string;

  @ApiPropertyOptional({
    description: 'IDs de archivos previamente subidos para vincular a este mensaje',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];
}
