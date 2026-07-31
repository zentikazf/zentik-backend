import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

  @ApiPropertyOptional({ description: 'Cantidad (usage) del GET de Botmaker. Base del cálculo por unidad.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  usage?: number;

  @ApiPropertyOptional({ description: 'Valor crudo (USD) del GET de Botmaker. Null en variables manuales.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  rawValue?: number;

  @ApiProperty({ example: 415.81, description: 'Valor comercial (USD). El backend lo recalcula según la regla.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  commercialValue: number;

  @ApiProperty({ enum: ['BOTMAKER', 'MANUAL'] })
  @IsIn(['BOTMAKER', 'MANUAL'])
  source: 'BOTMAKER' | 'MANUAL';

  // #23: regla de precio persistida (contrato del cliente). DIRECTO = crudo; CALCULO = (usage−incluidas)×precio;
  //   MANUAL = valor tipeado a mano (fee fijo, override). Se arrastra al re-importar el mes siguiente.
  @ApiPropertyOptional({ enum: ['DIRECTO', 'CALCULO', 'MANUAL'] })
  @IsOptional()
  @IsIn(['DIRECTO', 'CALCULO', 'MANUAL'])
  mode?: 'DIRECTO' | 'CALCULO' | 'MANUAL';

  @ApiPropertyOptional({ description: 'CALCULO: cantidad incluida/no cobrable antes de aplicar el precio unitario.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  incluidas?: number;

  @ApiPropertyOptional({ description: 'CALCULO: precio unitario (USD) por unidad cobrable.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({
    enum: ['MULT', 'DIV'],
    description: 'CALCULO: operación. MULT (default) = cobrables × precio; DIV = cobrables ÷ divisor (unidades por USD, p. ej. tokens).',
  })
  @IsOptional()
  @IsIn(['MULT', 'DIV'])
  op?: 'MULT' | 'DIV';

  @ApiPropertyOptional({
    default: true,
    description:
      'Ojito: false = variable DESHABILITADA — no suma al total, no entra en la factura y el cliente no la ve en el portal. La regla queda guardada.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
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
