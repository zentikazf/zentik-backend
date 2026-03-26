import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBoardDto {
  @ApiProperty({ example: 'Sprint Board', description: 'Nombre del tablero' })
  @IsString({ message: 'El nombre es requerido' })
  @MinLength(1, { message: 'El nombre no puede estar vacio' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;
}
