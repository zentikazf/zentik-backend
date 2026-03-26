import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePermissionsDto {
  @ApiProperty({
    example: ['clxxxxxxxxx1', 'clxxxxxxxxx2'],
    description: 'IDs de los permisos a asignar al rol (reemplaza los existentes)',
    type: [String],
  })
  @IsArray({ message: 'Los permisos deben ser un arreglo' })
  @ArrayMinSize(0)
  @IsString({ each: true, message: 'Cada permiso debe ser un ID valido' })
  permissionIds: string[];
}
