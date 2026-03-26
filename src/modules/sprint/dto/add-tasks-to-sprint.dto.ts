import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddTasksToSprintDto {
  @ApiProperty({
    example: ['cltask123', 'cltask456'],
    description: 'IDs de las tareas a agregar al sprint',
    type: [String],
  })
  @IsArray({ message: 'Se requiere un arreglo de IDs de tareas' })
  @ArrayMinSize(1, { message: 'Debe incluir al menos una tarea' })
  @IsString({ each: true, message: 'Cada ID de tarea debe ser una cadena' })
  taskIds: string[];
}
