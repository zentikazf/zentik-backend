import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddMemberDto {
  @ApiProperty({ example: 'cluser1', description: 'ID del usuario a agregar' })
  @IsString({ message: 'El ID del usuario es requerido' })
  userId: string;
}
