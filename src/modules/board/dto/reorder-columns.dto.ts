import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ReorderColumnsDto {
  @ApiProperty({
    example: ['clxyz123', 'clxyz456', 'clxyz789'],
    description: 'IDs de las columnas en el orden deseado',
    type: [String],
  })
  @IsArray({ message: 'Se requiere un arreglo de IDs de columnas' })
  @ArrayMinSize(1, { message: 'Debe incluir al menos una columna' })
  @IsString({ each: true, message: 'Cada ID de columna debe ser una cadena' })
  columnIds: string[];
}
