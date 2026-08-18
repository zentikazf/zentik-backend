import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Preview (dry-run) de aplicar un paquete a un proyecto. NO escribe nada. */
export class PreviewContractPackageDto {
  @ApiProperty({ description: 'ID del paquete a previsualizar' })
  @IsString()
  packageId: string;
}

/**
 * La decisión del usuario para UN tipo, tomada sobre el preview.
 *
 * Solo tiene efecto sobre los "configurado distinto": es el checkbox
 * "pisar este" del mockup que aprobó el dueño. Sobre un tipo nuevo o uno ya
 * igual, `overwrite` no cambia nada.
 */
export class ApplyContractPackageItemDto {
  @ApiProperty({ description: 'ID del tipo de solicitud sobre el que se decide' })
  @IsString()
  ticketTypeId: string;

  @ApiPropertyOptional({
    default: false,
    description: 'true = pisar la política que este proyecto ya tiene para ese tipo.',
  })
  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;
}

/**
 * ⛔ El cliente manda DECISIONES, no el resultado del preview.
 *
 * Las tres categorías se recalculan en el backend en el momento de escribir. Si
 * el front mandara el write-set ya armado, un preview viejo (otra pestaña, otro
 * usuario editando el mismo proyecto) escribiría sobre un estado que ya no es el
 * que el usuario vio, y el checkbox "pisar este" dejaría de significar lo que
 * dice. Acá lo peor que puede pasar con un preview viejo es que un "pisar" caiga
 * sobre algo que mientras tanto quedó igual: un no-op.
 */
export class ApplyContractPackageDto {
  @ApiProperty({ description: 'ID del paquete a aplicar' })
  @IsString()
  packageId: string;

  @ApiPropertyOptional({
    type: [ApplyContractPackageItemDto],
    description: 'Decisiones caso por caso. Omitir la lista = no pisar nada (el default del dueño).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: 'No se pueden enviar más de 200 decisiones por request' })
  @ValidateNested({ each: true })
  @Type(() => ApplyContractPackageItemDto)
  items?: ApplyContractPackageItemDto[];
}
