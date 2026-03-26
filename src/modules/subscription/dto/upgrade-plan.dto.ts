import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpgradePlanDto {
  @ApiProperty({ enum: ['FREE', 'PRO', 'ENTERPRISE'] })
  @IsString()
  @IsIn(['FREE', 'PRO', 'ENTERPRISE'])
  plan: string;
}
