import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsDateString, MaxLength } from 'class-validator';

export class CreateMeetingDto {
  @ApiProperty({ example: 'Revisión de alcance con cliente' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: 'Revisar documento de alcance y definir próximos pasos' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: '2026-04-01T10:00:00.000Z' })
  @IsDateString()
  date: string;

  @ApiPropertyOptional({ example: '2026-04-01T11:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: 'Google Meet / Oficina central' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({ example: true, description: 'Enviar notificación al cliente' })
  @IsOptional()
  @IsBoolean()
  notifyClient?: boolean;
}
