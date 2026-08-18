import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Una fila del PUT de ítems del paquete.
 *
 * Es el MISMO shape que `ProjectContractItemDto` a propósito: el editor de árbol
 * es compartido (#58 R2) y su `buildPayload` produce este objeto sin adaptadores.
 * `contractNotes` no está: el ítem de paquete no las lleva (#58 R1.2, fuera de
 * alcance); si el editor la manda, se ignora.
 */
export class ContractPackageItemDto {
  @ApiProperty({ description: 'ID del tipo de solicitud' })
  @IsString()
  ticketTypeId: string;

  /**
   * OBLIGATORIA salvo cuando la fila viene a SACAR el tipo del paquete
   * (`isActive: false`). Mismo `@ValidateIf` que el DTO de contratos: gobierna
   * TODA la propiedad, así que con `isActive: false` no se valida nada.
   */
  @ApiPropertyOptional({
    description: 'ID de la política que el paquete asigna a ese tipo. Obligatoria salvo con isActive: false.',
  })
  @ValidateIf((o) => o.isActive !== false)
  @IsString()
  slaPolicyId?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'false SACA el tipo del paquete: la fila se BORRA (en un paquete "no está" es una fila ausente, no un flag apagado).',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * ⚠️ SEMÁNTICA (#58 R3.4): igual que el PUT de contratos, es un upsert de las
 * filas ENVIADAS — lo que no viaja queda intacto. La diferencia es qué significa
 * apagar: acá `isActive: false` **BORRA** el ítem en vez de desactivarlo.
 *
 * Es lo que permite reusar `buildPayload` del editor casi verbatim y deja el
 * almacenamiento limpio: un paquete es una lista de lo que SÍ trae.
 */
export class UpsertContractPackageItemsDto {
  @ApiProperty({
    type: [ContractPackageItemDto],
    description: 'Filas a persistir (upsert por tipo; isActive:false borra; lo omitido no se toca)',
  })
  @IsArray()
  @ArrayMaxSize(200, { message: 'No se pueden enviar más de 200 ítems por request' })
  @ValidateNested({ each: true })
  @Type(() => ContractPackageItemDto)
  items: ContractPackageItemDto[];
}
