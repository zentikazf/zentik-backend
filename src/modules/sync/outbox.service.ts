import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import {
  EnqueueInput,
  OutboxRow,
} from './types/outbox.types';

/**
 * Evento interno de baja latencia (#50 R4): "se escribio una fila en el outbox".
 * Lo escucha SyncDispatcherService para agendar el drenado con debounce. Es un
 * trigger best-effort, NUNCA fuente de verdad (la verdad es la fila; el cron
 * horario sigue siendo la red de seguridad).
 */
export const OUTBOX_ENQUEUED_EVENT = 'outbox.enqueued';

/**
 * Repositorio del outbox `outbox_events` (feature #13).
 *
 * Frontera de capa (design §3): este service cumple el rol de repositorio de su
 * propia tabla, igual que TicketEventsService con `ticket_events`. `enqueueTx`
 * recibe el `tx` del caller (no abre su propia transaccion), molde de
 * `TicketEventsService.writeEventTx` (ticket-events.service.ts:48-63).
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Escribe una outbox-row `pending` DENTRO de la transaccion del caller (R1).
   * Si el caller hace rollback, la fila desaparece con la tx (R2) — garantia
   * nativa de Prisma, sin codigo extra. NO abre su propia transaccion.
   *
   * Molde exacto: TicketEventsService.writeEventTx (mismo cast a InputJsonValue).
   *
   * Devuelve `true` si escribio fila y `false` si fue no-op por flag/whitelist
   * (#50 D8): el caller usa ese booleano para decidir si llamar `notifyEnqueued()`
   * DESPUES del commit. Backward-compatible con los callers que la `await`ean sin
   * mirar el valor.
   *
   * ⚠️ Esta funcion NO agenda ningun drenado: corre dentro de la tx, y si la tx
   * revierte no hay nada que drenar (R4.3). El disparo es post-commit, afuera.
   */
  async enqueueTx(
    tx: Prisma.TransactionClient,
    input: EnqueueInput,
  ): Promise<boolean> {
    // GATE de scoping multi-tenant: solo se capturan tickets de las orgs
    // habilitadas (ONNIX_SYNC_ORG_IDS) y con la feature on. No-op silencioso
    // para orgs no habilitadas o feature off — el outbox no captura nada de ellas.
    if (
      !this.config.onnixSyncEnabled ||
      !this.config.onnixSyncOrgIds.includes(input.organizationId)
    ) {
      return false;
    }
    await tx.outboxEvent.create({
      data: {
        eventType: input.eventType,
        aggregateId: input.aggregateId,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        payloadVersion: 1,
        status: 'pending',
      },
    });
    return true;
  }

  /**
   * Avisa que hay filas nuevas para drenar (#50 R4.1). El caller la invoca
   * DESPUES de que resolvio su `$transaction` (post-commit, R4.3) y SOLO si
   * `enqueueTx` devolvio `true`.
   *
   * Emision sincrona y sin await a proposito: es best-effort puro. Si nadie
   * escucha o el listener falla, la fila sigue en `pending` y el cron horario la
   * levanta. El gate del flag lo aplica el listener (SyncDispatcherService).
   */
  notifyEnqueued(): void {
    this.events.emit(OUTBOX_ENQUEUED_EVENT);
  }

  /**
   * Reclama atomicamente hasta `limit` filas elegibles, marcandolas `in_flight`
   * con `locked_at=now()`, y las devuelve (R11, R12).
   *
   * - `FOR UPDATE SKIP LOCKED` sobre el SELECT interno: dos drains nunca toman la
   *   misma fila (R12). El UPDATE ... WHERE id IN (SELECT ...) aplica el lock y
   *   marca `in_flight` de forma atomica.
   * - Reclama tambien filas `in_flight` colgadas cuyo `locked_at` supera
   *   STALE_LOCK_MS (cubre crash entre claim y markSynced sin deadlock silencioso).
   * - Tagged-template: `${staleMs}` y `${limit}` van como bind params, NO
   *   concatenacion → anti-inyeccion (molde report.service $queryRaw). PROHIBIDO
   *   `$queryRawUnsafe` con interpolacion de strings.
   * - Devuelve filas ⇒ `$queryRaw` (no `$executeRaw`, que devuelve count).
   *
   * ⚠️ ORDEN DE SALIDA (#50): el `ORDER BY created_at` del subquery decide QUE
   * filas entran, pero NO el orden del `RETURNING` del UPDATE de afuera —
   * Postgres devuelve esas filas en el orden del plan (heap/hash), no cronologico.
   * Con #13 daba igual; con COMMENT_ADDED el orden de los POST ES el orden en que
   * OSD muestra la conversacion, asi que una rafaga de mensajes (justo lo que el
   * debounce agrupa a proposito) podia aparecer desordenada en el hilo. Por eso el
   * UPDATE va envuelto en un CTE y el orden se impone en el SELECT de afuera:
   * queda garantizado para TODO consumidor, presente y futuro, sin depender de que
   * cada caller se acuerde de ordenar.
   */
  async claim(limit: number): Promise<OutboxRow[]> {
    const staleMs = this.config.onnixSyncStaleLockMs;
    return this.prisma.$queryRaw<OutboxRow[]>`
      WITH claimed AS (
        UPDATE outbox_events SET status = 'in_flight', locked_at = now()
        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'pending'
             OR (status = 'in_flight' AND locked_at < now() - (${staleMs}::int * interval '1 millisecond'))
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING *
      )
      SELECT * FROM claimed ORDER BY created_at ASC`;
  }

  /**
   * Marca una fila como sincronizada con exito (R14). Persiste el `externalId`
   * (code Onnix) cuando aplica (TICKET_CREATED). Update normal por id: la fila ya
   * fue reclamada, no hay lock que ganar (D4).
   */
  async markSynced(id: string, externalId?: string | null): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'synced',
        syncedAt: new Date(),
        ...(externalId ? { externalId } : {}),
      },
    });
  }

  /**
   * Marca un fallo. `terminal=true` → `failed` (poison message / 422 / cliente no
   * mapeado). `terminal=false` → `attempts++` y vuelve a `pending` para reintento
   * (5xx/red/timeout mientras no se alcance el cap). El cap a `failed` lo decide
   * el caller comparando attempts contra ONNIX_SYNC_MAX_ATTEMPTS (R30-R32).
   */
  async markFailed(id: string, error: string, terminal: boolean): Promise<void> {
    const lastError = error.slice(0, 5000);
    if (terminal) {
      await this.prisma.outboxEvent.update({
        where: { id },
        data: { status: 'failed', lastError, lockedAt: null },
      });
    } else {
      await this.prisma.outboxEvent.update({
        where: { id },
        data: {
          status: 'pending',
          lastError,
          attempts: { increment: 1 },
          lockedAt: null,
        },
      });
    }
  }

  /**
   * Re-encola filas `failed` (reconciliacion R39): vuelve a `pending` y resetea
   * attempts/lastError para reintentar (p. ej. cliente que paso a estar mapeado).
   * Devuelve el numero de filas re-encoladas.
   */
  async requeueFailed(rowIds: string[]): Promise<number> {
    if (rowIds.length === 0) return 0;
    const result = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: rowIds }, status: 'failed' },
      data: { status: 'pending', attempts: 0, lastError: null, lockedAt: null },
    });
    return result.count;
  }

  /**
   * Devuelve una fila `in_flight` a `pending` SIN incrementar attempts. Para el
   * ordering gate (R24): un STATUS_CHANGED que aun no puede enviarse (su
   * TICKET_CREATED todavia no tiene code) se libera para reintentar el proximo
   * ciclo, sin contar como fallo.
   */
  async release(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'pending', lockedAt: null },
    });
  }

  /**
   * `externalId` de la outbox-row TICKET_CREATED de un ticket (para gate de
   * ordering: STATUS_CHANGED solo se envia si la creacion ya tiene code — R23).
   * Devuelve null si no existe o aun no esta sincronizada.
   */
  async getCreatedExternalId(aggregateId: string): Promise<string | null> {
    const row = await this.prisma.outboxEvent.findFirst({
      where: { aggregateId, eventType: 'TICKET_CREATED', externalId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { externalId: true },
    });
    return row?.externalId ?? null;
  }
}
