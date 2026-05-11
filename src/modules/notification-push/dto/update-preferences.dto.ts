import { IsArray, IsBoolean, IsIn, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { NOTIFICATION_CHANNELS, NotificationChannel } from '../push-events.constants';

export class PreferenceItemDto {
  @ApiProperty({ description: 'Tipo de evento (ej: chat.message, task.assigned)' })
  @IsString()
  eventType!: string;

  @ApiProperty({ enum: NOTIFICATION_CHANNELS, default: 'PUSH' })
  @IsIn(NOTIFICATION_CHANNELS as readonly string[])
  channel!: NotificationChannel;

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
