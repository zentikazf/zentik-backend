import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from './outbox.service';

/**
 * Reconciliación v1 (feature #13, D6 — alcance mínimo aprobado).
 *
 * Red de seguridad contra los agujeros que el outbox no cubre:
 * 1. Re-encolar filas `failed` re-evaluables: TICKET_CREATED que fallaron por
 *    "cliente no mapeado" y cuyo cliente HOY sí tiene fila en
 *    `onnix_entity_mappings` → vuelven a `pending` (R39).
 * 2. Detectar tickets de soporte RECIENTES sin outbox-row TICKET_CREATED (pérdida
 *    pre-outbox; con outbox-in-transaction debería dar 0) → se reportan, NO se
 *    crean automáticamente en v1 (R40).
 *
 * Drift por `updatedAt > syncedAt` y huérfanos en Onnix = fase 2 (fuera de scope).
 * Se filtra a tickets de los últimos N días para no marcar como "faltantes" todo
 * el histórico anterior a la feature (que por diseño no se backfillea).
 */
@Injectable()
export class SyncReconciliationService {
  private readonly logger = new Logger(SyncReconciliationService.name);
  private static readonly RECENT_DAYS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async reconcileV1(): Promise<{ requeued: number; missing: number }> {
    const requeued = await this.requeueReevaluableFailed();
    const missing = await this.detectMissing();
    this.logger.log(`onnix-sync reconcile: requeued=${requeued} missing=${missing}`);
    return { requeued, missing };
  }

  /** Re-encola TICKET_CREATED `failed` cuyo cliente ya tiene mapeo (R39). */
  private async requeueReevaluableFailed(): Promise<number> {
    const failed = await this.prisma.outboxEvent.findMany({
      where: { status: 'failed', eventType: 'TICKET_CREATED' },
      select: { id: true, aggregateId: true, payload: true },
    });
    const ids: string[] = [];
    for (const row of failed) {
      const clientId = (row.payload as { clientId?: string } | null)?.clientId;
      if (!clientId) continue;
      // El payload no persiste organizationId; el mapeo es scoped por org
      // (clave compuesta), asi que resolvemos la org del ticket por aggregateId.
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: row.aggregateId },
        select: { organizationId: true },
      });
      if (!ticket) continue;
      const mapping = await this.prisma.onnixEntityMapping.findUnique({
        where: {
          organizationId_entityType_zentikId: {
            organizationId: ticket.organizationId,
            entityType: 'client',
            zentikId: clientId,
          },
        },
        select: { id: true },
      });
      if (mapping) ids.push(row.id);
    }
    return this.outbox.requeueFailed(ids);
  }

  /** Cuenta tickets recientes sin outbox-row TICKET_CREATED y los reporta (R40). */
  private async detectMissing(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM tickets t
      WHERE t.created_at > now() - (${SyncReconciliationService.RECENT_DAYS}::int * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM outbox_events o
          WHERE o.aggregate_id = t.id AND o.event_type = 'TICKET_CREATED'
        )`;
    const count = Number(rows[0]?.count ?? 0n);
    if (count > 0) {
      this.logger.warn(
        `onnix-sync reconcile: ${count} ticket(s) reciente(s) sin outbox-row TICKET_CREATED (revisar)`,
      );
    }
    return count;
  }
}
