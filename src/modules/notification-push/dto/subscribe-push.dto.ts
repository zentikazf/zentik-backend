import { IsString, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubscribePushDto {
  @ApiProperty({ description: 'Endpoint unico de la suscripcion push' })
  @IsString()
  endpoint!: string;

  @ApiProperty({ description: 'Claves criptograficas { p256dh, auth }' })
  @IsObject()
  keys!: { p256dh: string; auth: string };

  @ApiPropertyOptional({ description: 'User agent del navegador' })
  @IsOptional()
  @IsString()
  userAgent?: string;
}

export class UnsubscribePushDto {
  @ApiProperty({ description: 'Endpoint de la suscripcion a eliminar' })
  @IsString()
  endpoint!: string;
}
