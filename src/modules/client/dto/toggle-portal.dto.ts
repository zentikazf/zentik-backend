import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * #65 T3 (C2.2) — era `@Body() body: { enabled: boolean }`, un tipo inline sin validación.
 *
 * `togglePortal` (client.service.ts:529) escribe `enabled` en `portalEnabled`, que es lo que
 * decide si los usuarios del cliente pueden entrar al portal. Sin DTO, un `enabled: "false"`
 * (string, que es lo que manda un form HTML crudo) es truthy y **habilitaba** el portal
 * cuando el operador quiso apagarlo. Con `@IsBoolean()` eso es un 400 explícito.
 */
export class TogglePortalDto {
  @ApiProperty({ example: true, description: 'Habilita o deshabilita el portal del cliente.' })
  @IsBoolean({ message: 'El valor debe ser booleano (true o false)' })
  enabled!: boolean;
}
