import { IsString, IsOptional, IsEnum, IsArray, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ChannelTypeDto {
  DM = 'DM',
  GROUP = 'GROUP',
  PROJECT = 'PROJECT',
}

export class CreateChannelDto {
  @ApiProperty({
    example: 'general',
    description: 'Nombre del canal',
  })
  @IsString({ message: 'El nombre del canal es requerido' })
  @MinLength(1, { message: 'El nombre no puede estar vacio' })
  @MaxLength(100, { message: 'El nombre no puede exceder 100 caracteres' })
  name: string;

  @ApiProperty({ enum: ChannelTypeDto, description: 'Tipo de canal' })
  @IsEnum(ChannelTypeDto, { message: 'El tipo de canal no es valido' })
  type: ChannelTypeDto;

  @ApiPropertyOptional({ example: 'Canal para discutir el proyecto', description: 'Descripcion del canal' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La descripcion no puede exceder 500 caracteres' })
  description?: string;

  @ApiPropertyOptional({ example: ['cluser1', 'cluser2'], description: 'IDs de miembros a agregar', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberIds?: string[];

  @ApiPropertyOptional({ example: 'clproject1', description: 'ID del proyecto (para canales tipo PROJECT)' })
  @IsOptional()
  @IsString()
  projectId?: string;
}
