import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * H9b: emite (o previsualiza) una nota de crédito sobre una factura SENT/PAID. Acredita líneas
 * ENTERAS (por id de HoursTransaction estampada). `returnHoursToBillable` default true en el service
 * si viene undefined (toggle "devolver horas al pool" → fila espejo re-facturable).
 */
export class CreateCreditNoteDto {
  @ApiProperty({ description: 'Ids de las líneas (HoursTransaction estampadas) a acreditar.', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  lineIds!: string[];

  @ApiProperty({ description: 'Motivo de la nota de crédito (obligatorio, queda en el registro).', maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Devolver las horas acreditadas al pool facturable (default true).' })
  @IsOptional()
  @IsBoolean()
  returnHoursToBillable?: boolean; // default true en el service si viene undefined
}
