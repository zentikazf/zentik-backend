import { IsString, IsOptional, IsInt, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateInviteDto {
  @ApiProperty({
    example: 'clxxxxxxxxxxxxxxxxx',
    description: 'ID del rol que se asignara a los usuarios que acepten la invitacion',
  })
  @IsString({ message: 'El ID del rol es requerido' })
  roleId: string;

  @ApiPropertyOptional({
    example: 10,
    description: 'Numero maximo de usos del enlace de invitacion',
  })
  @IsOptional()
  @IsInt({ message: 'El numero maximo de usos debe ser un entero' })
  @Min(1, { message: 'El numero maximo de usos debe ser al menos 1' })
  maxUses?: number;

  @ApiPropertyOptional({
    example: '2026-04-14T00:00:00.000Z',
    description: 'Fecha de expiracion del enlace de invitacion',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La fecha de expiracion no es valida' })
  expiresAt?: string;
}
