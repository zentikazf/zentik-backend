import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum CloseReasonDto {
  RESOLVED_BY_SUPPORT = 'RESOLVED_BY_SUPPORT',
  RESOLVED_BY_CLIENT = 'RESOLVED_BY_CLIENT',
  DUPLICATE = 'DUPLICATE',
  SPAM = 'SPAM',
  OTHER = 'OTHER',
}

export class CloseTicketDto {
  @ApiProperty({ enum: CloseReasonDto, description: 'Motivo del cierre del ticket' })
  @IsEnum(CloseReasonDto, { message: 'El motivo de cierre no es valido' })
  reason: CloseReasonDto;

  // #43 R1b.1: la cancelación exige comentario. El campo conserva su nombre
  // histórico (`note`) y es INTERNO — nunca viaja por los endpoints del portal
  // (lista prohibida del test anti-fuga junto a adminNotes).
  @ApiProperty({ description: 'Comentario de la cancelación (obligatorio, interno — el cliente no lo ve)' })
  @IsString()
  @IsNotEmpty({ message: 'El comentario de cancelación es obligatorio' })
  @MaxLength(500, { message: 'La nota no puede exceder 500 caracteres' })
  note: string;
}
