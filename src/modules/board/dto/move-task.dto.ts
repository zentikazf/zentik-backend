import { IsString, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MoveTaskDto {
  @ApiProperty({ example: 'clxyz123', description: 'ID de la tarea a mover' })
  @IsString({ message: 'El ID de la tarea es requerido' })
  taskId: string;

  @ApiProperty({ example: 'clxyz456', description: 'ID de la columna destino' })
  @IsString({ message: 'El ID de la columna destino es requerido' })
  targetColumnId: string;

  @ApiProperty({ example: 0, description: 'Posicion de la tarea en la columna destino' })
  @IsInt({ message: 'La posicion debe ser un numero entero' })
  @Min(0, { message: 'La posicion no puede ser negativa' })
  position: number;
}
