import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * #65 T3 (C2.2) — era `@Body() body: { hours: number; note?: string }`, sin validación.
 *
 * `addHours` (client.service.ts:818) hace `contractedHours: { increment: hours }` sin ningún
 * chequeo. Sin DTO entraba cualquier cosa:
 *   - `hours: -10` → RESTA horas contratadas por la puerta de "agregar horas", que es una
 *     mutación destructiva disfrazada de alta y sin motivo registrado.
 *   - `hours: "abc"` → `increment: NaN`; Postgres rechaza y sale un 500 sin explicación.
 *   - `hours: 0` → una fila PURCHASE inútil en el ledger.
 *
 * El `@Min(0.01)` espeja el de `EditHoursTransactionDto`, que ya lo tenía bien.
 */
export class AddHoursDto {
  @ApiProperty({ example: 10, description: 'Horas a agregar al cupo contratado (> 0).' })
  @Type(() => Number)
  @IsNumber({}, { message: 'Las horas deben ser un numero' })
  @Min(0.01, { message: 'Las horas deben ser mayores a 0' })
  hours!: number;

  @ApiPropertyOptional({ example: 'Ampliación de contrato marzo', description: 'Nota libre.' })
  @IsOptional()
  @IsString({ message: 'La nota debe ser un texto' })
  @MaxLength(500, { message: 'La nota no puede superar los 500 caracteres' })
  note?: string;
}
