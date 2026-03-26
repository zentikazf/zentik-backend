import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class StartTimerDto {
  @ApiProperty({
    example: 'clxyz123abc',
    description: 'ID de la tarea en la que se inicia el temporizador',
  })
  @IsString({ message: 'El ID de la tarea es requerido' })
  taskId: string;
}
