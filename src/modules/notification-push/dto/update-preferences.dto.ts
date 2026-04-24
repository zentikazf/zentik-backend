import { IsArray, IsBoolean, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class PreferenceItemDto {
  @ApiProperty({ description: 'Tipo de evento (ej: chat.message, task.assigned)' })
  @IsString()
  eventType!: string;

  @ApiProperty({ default: 'PUSH' })
  @IsString()
  channel!: string;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}

export class UpdatePreferencesDto {
  @ApiProperty({ type: [PreferenceItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  preferences!: PreferenceItemDto[];
}
