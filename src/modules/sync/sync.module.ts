import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from './outbox.module';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { SyncAdminController } from './sync-admin.controller';

/**
 * Módulo de sincronización Zentik → Onnix (feature #13).
 *
 * Autocontenido y removible (R48): para eliminar la integración basta borrar este
 * módulo, su import en `app.module.ts`, los 3 `enqueueTx` de ticket/portal service,
 * y la tabla `outbox_events`. Nada más depende de él salvo el `OutboxService` que
 * exporta (consumido por TicketModule/PortalModule para encolar en su transacción).
 *
 * - PrismaModule / RedisModule / AppConfigModule son @Global → no se importan.
 * - Importa AuthModule para reusar AuthGuard + RolesGuard (no duplicarlos), igual
 *   que admin-mcp.module (feature #8).
 * - `@Cron`/`@OnEvent` se descubren globalmente (ScheduleModule.forRoot ya está en
 *   ticket.module; EventEmitterModule.forRoot es global en app.module) — NO se
 *   re-registra `forRoot` aquí.
 */
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [SyncAdminController],
  providers: [
    OnnixClientService,
    OnnixMappingService,
    SyncDispatcherService,
    SyncReconciliationService,
  ],
})
export class SyncModule {}
