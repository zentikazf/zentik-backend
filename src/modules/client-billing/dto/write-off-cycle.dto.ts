import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * #65 T12 (A1.4) — "Cerrar sin cobro": la factura se da por saldada SIN que haya entrado plata.
 *
 * Calcado de `ReopenCycleDto`: el repo ya tiene una convención para las operaciones con motivo
 * obligatorio (anular y emitir NC son las dos POST dedicadas con DTO propio y `reason` de mínimo
 * 3 caracteres), y ésta es exactamente esa forma. Se hizo endpoint aparte y no un valor más del
 * `@IsIn` de `UpdateCycleDto` porque cerrar sin cobro no es una transición de estado más: exige
 * un motivo, y meterlo en el PATCH genérico habría dejado el motivo opcional.
 */
export class WriteOffCycleDto {
  @ApiProperty({
    description:
      'Motivo del cierre sin cobro (obligatorio, queda en el registro y en la auditoría). ' +
      'Ej.: "saldo 0 por NC-2026-00004", "incobrable".',
    maxLength: 500,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
