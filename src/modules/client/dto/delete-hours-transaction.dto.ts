import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * #65 T2 (C2.1) — el body del borrado de horas, con el molde de `EditHoursTransactionDto`.
 *
 * Antes era `@Body() body: { reason: string; deletedById: string }`: un tipo inline que el
 * `ValidationPipe` global no puede validar (no hay clase = no hay metadata de class-validator),
 * así que `reason` podía llegar vacío, `null` o de 10.000 caracteres y quedaba escrito tal cual
 * en `delete_reason`. El motivo es el ÚNICO rastro de por qué desapareció un movimiento del
 * ledger: si no se valida, la auditoría promete una explicación que puede no existir.
 *
 * ── Por qué `deletedById` SIGUE declarado acá si el service ya no lo usa ──────────────────
 * El actor pasó a salir de `@CurrentUser()` (C2.1): que el cliente diga quién borró es una
 * auditoría que miente por diseño. Pero el campo NO se puede simplemente eliminar del DTO,
 * porque `main.ts:72-74` monta el ValidationPipe con `forbidNonWhitelisted: true`: una
 * propiedad no declarada no se ignora, **se rechaza con 400**.
 *
 * El frontend de hoy manda `deletedById` (tiempo/page.tsx:442) y backend y frontend se deployan
 * por separado (Railway / Vercel). Sin esta declaración, la ventana entre los dos deploys deja
 * el borrado de horas roto con un 400 incomprensible. Declararlo `@IsOptional()` y descartarlo
 * es lo que hace que R6.2 se lea como está escrito: el `deletedById` del body **se ignora**
 * —no explota—, y el registro queda con el usuario de la sesión.
 *
 * Es un campo de compatibilidad, no de contrato: se puede borrar una vez que el frontend
 * nuevo esté en producción y no queden clientes viejos en el aire.
 */
export class DeleteHoursTransactionDto {
  @ApiProperty({
    example: 'Cargado sobre el ticket equivocado',
    description: 'Motivo del borrado. Queda en el ledger y en la auditoría.',
  })
  @IsString({ message: 'El motivo debe ser un texto' })
  @IsNotEmpty({ message: 'El motivo del borrado es obligatorio' })
  @MaxLength(500, { message: 'El motivo no puede superar los 500 caracteres' })
  reason!: string;

  /**
   * DEPRECADO — se acepta y se DESCARTA. El actor sale de la sesión (`@CurrentUser()`).
   * Existe sólo para que un frontend viejo no coma un 400 por `forbidNonWhitelisted`.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignorado. El autor del borrado se toma de la sesión.',
  })
  @IsOptional()
  @IsString()
  deletedById?: string;
}
