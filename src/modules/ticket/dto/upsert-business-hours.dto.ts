import { IsString, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertBusinessHoursDto {
  @ApiProperty({ example: '08:30' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'Formato de hora inválido, usar HH:MM' })
  businessHoursStart: string;

  @ApiProperty({ example: '17:30' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'Formato de hora inválido, usar HH:MM' })
  businessHoursEnd: string;

  @ApiProperty({ example: '1,2,3,4,5', description: '1=Lun...7=Dom' })
  @IsString()
  @Matches(/^[1-7](,[1-7])*$/, { message: 'Formato de días inválido' })
  businessDays: string;

  @ApiPropertyOptional({ example: 'America/Asuncion' })
  @IsOptional()
  @IsString()
  timezone?: string;
}
