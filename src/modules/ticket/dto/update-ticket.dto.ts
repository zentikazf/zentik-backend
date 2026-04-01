import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum TicketStatusDto {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: TicketStatusDto, description: 'Nuevo estado del ticket' })
  @IsOptional()
  @IsEnum(TicketStatusDto, { message: 'El estado no es valido' })
  status?: TicketStatusDto;

  @ApiPropertyOptional({ example: 'Se asigno al equipo de backend', description: 'Notas internas del administrador' })
  @IsOptional()
  @IsString()
  adminNotes?: string;
}
