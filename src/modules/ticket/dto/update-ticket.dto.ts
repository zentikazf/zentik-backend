import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum TicketStatusDto {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
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
  @MaxLength(2000, { message: 'Las notas no pueden exceder 2000 caracteres' })
  adminNotes?: string;

  @ApiPropertyOptional({ description: 'ID del usuario asignado al ticket (se aplica a la task asociada). Pasar null para des-asignar.' })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;
}
