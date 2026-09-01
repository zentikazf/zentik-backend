import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * #65 T3 (C2.2) — barrido de tipos inline del controller de clientes.
 *
 * Era `@Body() body: { status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' }`. Ese tipo sólo existe en
 * tiempo de compilación: en runtime el ValidationPipe no tiene nada que validar y `status`
 * llegaba como cualquier cosa hasta `changeStatus` (client.service.ts:258), que lo escribe
 * directo en la columna. Un `status: "ARCHIVADO"` mal tipeado dejaba el cliente en un estado
 * que ninguna pantalla sabe pintar y que ningún filtro encuentra.
 *
 * `DISABLED` y `ARCHIVED` además cierran tickets y matan sesiones del portal
 * (client.service.ts:346), así que no es un campo cosmético.
 */
export class ChangeClientStatusDto {
  @ApiProperty({
    enum: ['ACTIVE', 'DISABLED', 'ARCHIVED'],
    example: 'DISABLED',
    description: 'Nuevo estado del cliente.',
  })
  @IsIn(['ACTIVE', 'DISABLED', 'ARCHIVED'], {
    message: 'El estado debe ser ACTIVE, DISABLED o ARCHIVED',
  })
  status!: 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
}
