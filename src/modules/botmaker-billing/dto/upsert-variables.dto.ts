import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VariableItemDto {
  @ApiProperty({ example: 'SESSIONS', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ description: 'Valor crudo (USD) del GET de Botmaker. Null en variables manuales.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rawValue?: number;

  @ApiProperty({ example: 415.81, description: 'Valor comercial (USD, con markup). ≥ 0.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  commercialValue: number;

  @ApiProperty({ enum: ['BOTMAKER', 'MANUAL'] })
  @IsIn(['BOTMAKER', 'MANUAL'])
  source: 'BOTMAKER' | 'MANUAL';
}

export class UpsertVariablesDto {
  @ApiProperty({ type: [VariableItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariableItemDto)
  items: VariableItemDto[];

  @ApiPropertyOptional({ description: 'Nota del período (opcional).', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
