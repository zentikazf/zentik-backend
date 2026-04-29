import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ description: 'Nota libre opcional sobre el cierre' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La nota no puede exceder 500 caracteres' })
  note?: string;
}
