import { IsArray, ValidateNested, IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { CriticalityDto } from './create-category-config.dto';

export class SlaConfigItemDto {
  @ApiProperty({ enum: CriticalityDto })
  @IsEnum(CriticalityDto)
  criticality: CriticalityDto;

  @ApiProperty({ example: 120, description: 'Tiempo de respuesta en minutos' })
  @IsInt()
  @Min(1)
  responseTimeMinutes: number;

  @ApiProperty({ example: 480, description: 'Tiempo de resolución en minutos' })
  @IsInt()
  @Min(1)
  resolutionTimeMinutes: number;
}

export class UpsertSlaConfigDto {
  @ApiProperty({ type: [SlaConfigItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaConfigItemDto)
  configs: SlaConfigItemDto[];
}
