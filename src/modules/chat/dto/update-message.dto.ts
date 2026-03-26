import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateMessageDto {
  @ApiProperty({
    example: 'Mensaje editado: el deploy se hizo correctamente',
    description: 'Contenido actualizado del mensaje',
  })
  @IsString({ message: 'El contenido del mensaje es requerido' })
  @MinLength(1, { message: 'El mensaje no puede estar vacio' })
  @MaxLength(5000, { message: 'El mensaje no puede exceder 5000 caracteres' })
  content: string;
}
