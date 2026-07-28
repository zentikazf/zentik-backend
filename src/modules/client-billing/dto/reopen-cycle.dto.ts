import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * H8d/A3: anular (reabrir) un ciclo exige MOTIVO obligatorio. Queda como registro contable
 * permanente (keep-data): la factura anulada se muestra marcada "Anulada" con su motivo y fecha.
 */
export class ReopenCycleDto {
  @ApiProperty({ description: 'Motivo de la anulación (obligatorio, queda en el registro).', maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  cancelReason!: string;
}
