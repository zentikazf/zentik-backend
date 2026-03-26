import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignTaskDto {
  @ApiProperty({ example: 'cluser123', description: 'ID del usuario a asignar' })
  @IsString({ message: 'El ID del usuario es requerido' })
  userId: string;
}
