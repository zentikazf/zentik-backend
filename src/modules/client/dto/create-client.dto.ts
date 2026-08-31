import {
  IsString,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
  IsEmail,
  IsNumber,
  Min,
  Max,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClientDto {
  @ApiProperty({ example: 'ACME Corp', minLength: 2, maxLength: 150 })
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ example: 'contacto@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+595 21 123456' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'Cliente preferencial' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 250000, description: 'Tarifa por hora para tareas de desarrollo (PROJECT)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  developmentHourlyRate?: number;

  @ApiPropertyOptional({ example: 300000, description: 'Tarifa por hora para tareas de soporte/tickets (SUPPORT)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  supportHourlyRate?: number;

  @ApiPropertyOptional({ example: 'PYG', enum: ['PYG', 'USD', 'EUR'] })
  @IsOptional()
  @IsString()
  @IsIn(['PYG', 'USD', 'EUR'])
  currency?: string;

  // #63 — IVA del cliente. Los dos NULLABLES a propósito: `null` es el APAGADO (el estado de todos los
  //   clientes al desplegar la feature) y tiene que poder mandarse para apagar el IVA de uno que lo tenía.
  //   Por eso van con `@ValidateIf` en vez de `@IsOptional()`, que descarta la validación cuando el valor
  //   es null y dejaría pasar cualquier cosa. `taxRate` es una FRACCIÓN (0.1 = 10%), no un porcentaje: el
  //   front divide por 100 antes de mandar. El techo de 1 es el de la columna `Decimal(5,4)` — una tasa
  //   ≥ 1 no cabe y además no existe como IVA.
  @ApiPropertyOptional({
    example: 0.1,
    description: 'IVA como FRACCIÓN (0.1 = 10%). null = cliente sin IVA (comportamiento previo a #63).',
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate?: number | null;

  @ApiPropertyOptional({
    enum: ['EXCLUDED', 'INCLUDED'],
    description:
      'EXCLUDED = la tarifa cargada es NETA y el IVA se suma (el total sube). ' +
      'INCLUDED = la tarifa YA trae el IVA adentro (el total no se mueve). null = sin IVA.',
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @IsIn(['EXCLUDED', 'INCLUDED'])
  taxMode?: string | null;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description: 'Si true, los usuarios portal del cliente ven la pagina /portal/billing',
  })
  @IsOptional()
  @IsBoolean({ message: 'portalBillingEnabled debe ser un booleano' })
  portalBillingEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Cuenta Botmaker mapeada (accountId del GET de consumo). #23. Recambiable; null desmapea.',
    example: 'IC0XXEN8LOZW38EW2XP2',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  botmakerAccountId?: string;
}
