import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Módulo mínimo que provee `OutboxService` (feature #13).
 *
 * Separado de `SyncModule` para que `TicketModule`/`PortalModule` puedan consumir
 * `OutboxService` (encolar `enqueueTx` en su propia transacción) SIN arrastrar
 * `AuthModule` ni el cron/controller del sync — evita ciclos en el grafo de
 * módulos y mantiene una única instancia. `PrismaModule`/`AppConfigModule` son
 * `@Global`, así que no se importan aquí.
 */
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
