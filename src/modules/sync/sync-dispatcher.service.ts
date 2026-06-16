import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService } from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { DrainResult, OutboxRow } from './types/outbox.types';
import { OnnixCreateTicketBody } from './types/onnix.types';

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** Resultado del procesamiento de una fila. `skipped` = ordering gate, no cuenta. */
type RowOutcome = 'synced' | 'failed' | 'skipped';

/**
 * Drenador del outbox → Onnix (feature #13, D2/D5/D7/D10).
 *
 * Disparado por `@Cron` horario (anti-solapamiento `waitForCompletion`) y por el
 * endpoint admin (mismo método `processPending`). `@OnEvent` es solo trigger de
 * baja latencia (best-effort), NUNCA fuente de verdad (R3, R4). El claim atómico
 * de `OutboxService` garantiza que dos drains concurrentes no tomen la misma fila.
 */
@Injectable()
export class SyncDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(SyncDispatcherService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly onnix: OnnixClientService,
    private readonly mapping: OnnixMappingService,
  ) {}

  // ── Disparadores ───────────────────────────────────────────────────────────

  @Cron(process.env.ONNIX_SYNC_CRON ?? '0 0 * * * *', {
    name: 'onnix-sync',
    waitForCompletion: true,
  })
  async tick(): Promise<void> {
    if (!this.config.onnixSyncEnabled) return;
    await this.processPending();
  }

  /** Trigger best-effort: despierta el drenado. NUNCA usa el payload como verdad. */
  @OnEvent('ticket.created')
  @OnEvent('ticket.updated')
  onTicketEvent(): void {
    if (!this.config.onnixSyncEnabled || this.running) return;
    void this.processPending().catch((e: unknown) =>
      this.logger.warn(
        `trigger drain falló (el cron lo recupera): ${(e as Error)?.message ?? e}`,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const start = Date.now();
    while (this.running && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await this.sleep(100);
    }
  }

  // ── Drenado ────────────────────────────────────────────────────────────────

  /** Procesa hasta `batchSize` filas pending. Mismo método para cron y endpoint. */
  async processPending(): Promise<DrainResult> {
    if (!this.config.onnixSyncEnabled) return { synced: 0, failed: 0 };
    const traceId = randomUUID();
    const result: DrainResult = { synced: 0, failed: 0 };
    this.running = true;
    try {
      const rows = await this.outbox.claim(this.config.onnixSyncBatchSize);
      for (const row of rows) {
        let outcome: RowOutcome;
        try {
          outcome = await this.processRow(row, traceId);
        } catch (err) {
          outcome = await this.handleUpstreamFailure(row, err);
        }
        if (outcome === 'synced') result.synced++;
        else if (outcome === 'failed') result.failed++;
      }
      await this.checkDlqAge();
    } finally {
      this.running = false;
    }
    this.logger.log(
      `onnix-sync drain done traceId=${traceId} synced=${result.synced} failed=${result.failed}`,
    );
    return result;
  }

  private async processRow(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    if (row.event_type === 'TICKET_CREATED') return this.processCreate(row, traceId);
    if (row.event_type === 'STATUS_CHANGED') return this.processStatus(row, traceId);
    await this.outbox.markFailed(row.id, `eventType desconocido: ${row.event_type}`, true);
    return 'failed';
  }

  // ── TICKET_CREATED ──────────────────────────────────────────────────────────

  private async processCreate(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    // Idempotencia: si ya tiene code, el ticket ya existe en Onnix (R13).
    if (row.external_id) {
      await this.outbox.markSynced(row.id, row.external_id);
      return 'synced';
    }
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: row.aggregate_id },
    });
    if (!ticket) {
      await this.outbox.markFailed(row.id, `ticket ${row.aggregate_id} no existe`, true);
      return 'failed';
    }

    const clientId = await this.mapping.resolveClientId(ticket.clientId);
    if (clientId === null) {
      this.log(row, traceId, 'failed', `cliente no mapeado: ${ticket.clientId}`);
      await this.outbox.markFailed(
        row.id,
        `cliente no mapeado en onnix_entity_mappings: ${ticket.clientId}`,
        true,
      );
      return 'failed';
    }
    const projectId = await this.mapping.resolveProjectId(ticket.projectId);
    const catalogIds = await this.mapping.resolveCatalogIds(
      ticket.category,
      ticket.priority,
      traceId,
    );

    const body: OnnixCreateTicketBody = {
      client_id: clientId,
      project_id: projectId,
      ticket_type_id: catalogIds.ticketTypeId,
      ticket_category_id: catalogIds.ticketCategoryId,
      ticket_priority_id: catalogIds.ticketPriorityId,
      subject: ticket.title.slice(0, 255),
      description: ticket.description ?? ticket.title,
      origin: 'api',
    };

    try {
      const outcome = await this.retryWithJitter(() =>
        this.onnix.createTicket(body, traceId),
      );
      if (outcome.ok && outcome.data?.code) {
        await this.outbox.markSynced(row.id, outcome.data.code);
        // Guardar el code en el ticket para UI/debug (best-effort, no crítico).
        await this.prisma.ticket
          .update({ where: { id: ticket.id }, data: { onnixCode: outcome.data.code } })
          .catch(() => undefined);
        this.log(row, traceId, 'synced', outcome.data.code);
        return 'synced';
      }
      // 422 de validación → terminal (catálogo/cliente inválido nunca tendrá éxito).
      await this.outbox.markFailed(
        row.id,
        `422 Onnix create: ${outcome.message ?? ''}`.slice(0, 4000),
        true,
      );
      return 'failed';
    } catch (err) {
      return this.handleUpstreamFailure(row, err);
    }
  }

  // ── STATUS_CHANGED ────────────────────────────────────────────────────────────

  private async processStatus(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    // Ordering gate (R23): el estado solo se envía si la creación ya tiene code.
    const code = await this.outbox.getCreatedExternalId(row.aggregate_id);
    if (!code) {
      // No es un fallo: vuelve a pending SIN contar intento; el próximo ciclo lo
      // reintenta después de crear el ticket en Onnix.
      await this.outbox.release(row.id);
      return 'skipped';
    }
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: row.aggregate_id },
      select: { status: true },
    });
    if (!ticket) {
      await this.outbox.markFailed(row.id, `ticket ${row.aggregate_id} no existe`, true);
      return 'failed';
    }
    // Estado ACTUAL (R22), no snapshot: si hubo N transiciones se envía el final.
    const slug = await this.mapping.resolveStatusSlug(ticket.status, traceId);

    try {
      const outcome = await this.retryWithJitter(() =>
        this.onnix.setEstado(code, slug, traceId),
      );
      if (outcome.ok) {
        await this.outbox.markSynced(row.id);
        this.log(row, traceId, 'synced', slug);
        return 'synced';
      }
      // 422 "ya está en ese estado" = éxito idempotente (R / §7 engineering spec).
      const msg = (outcome.message ?? '').toLowerCase();
      if (
        outcome.status === 422 &&
        (msg.includes('ya esta') ||
          msg.includes('ya está') ||
          msg.includes('ese estado') ||
          msg.includes('mismo estado'))
      ) {
        await this.outbox.markSynced(row.id);
        return 'synced';
      }
      // Otro 422 (slug inexistente/inactivo) → terminal.
      await this.outbox.markFailed(
        row.id,
        `422 Onnix estado: ${outcome.message ?? ''}`.slice(0, 4000),
        true,
      );
      return 'failed';
    } catch (err) {
      return this.handleUpstreamFailure(row, err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Marca un fallo transitorio (5xx/red/timeout/auth). Reintentable mientras no se
   * alcance el cap (R31/R32); al cap → terminal `failed`. attempts++ lo hace
   * `markFailed(terminal=false)`.
   */
  private async handleUpstreamFailure(row: OutboxRow, err: unknown): Promise<'failed'> {
    const reason =
      err instanceof OnnixUpstreamError
        ? `${err.upstreamStatus} ${err.upstreamReason ?? ''}`.trim()
        : ((err as Error)?.message ?? 'error desconocido');
    const willCap = row.attempts + 1 >= this.config.onnixSyncMaxAttempts;
    await this.outbox.markFailed(row.id, reason.slice(0, 4000), willCap);
    if (willCap) {
      this.logger.warn(`onnix-sync fila ${row.id} alcanzó el cap de intentos → failed`);
    }
    return 'failed';
  }

  /**
   * Reintento intra-drain con backoff exponencial + jitter (R33) SOLO para
   * transitorios (5xx/red/timeout). No modifica `common/utils/retry.ts` (global).
   * Los 422/401-auth no son transitorios y se propagan/clasifican afuera.
   */
  private async retryWithJitter<T>(
    fn: () => Promise<T>,
    attempts = 2,
    baseMs = 300,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const transient =
          err instanceof OnnixUpstreamError && err.upstreamStatus >= 500;
        if (!transient || i === attempts - 1) throw err;
        const backoff = baseMs * Math.pow(2, i);
        await this.sleep(backoff + Math.floor(Math.random() * backoff));
      }
    }
    throw lastErr;
  }

  /** Alerta DLQ por edad del mensaje `failed` más viejo (R44). */
  private async checkDlqAge(): Promise<void> {
    const oldest = await this.prisma.outboxEvent.findFirst({
      where: { status: 'failed' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    if (!oldest) return;
    const ageMin = (Date.now() - oldest.createdAt.getTime()) / 60_000;
    if (ageMin > this.config.onnixDlqMaxAgeMin) {
      this.logger.error(
        `onnix-sync DLQ: la fila failed más vieja supera ${this.config.onnixDlqMaxAgeMin}min ` +
          `(id=${oldest.id}, edad=${Math.round(ageMin)}min)`,
      );
    }
  }

  /** Log estructurado por intento, sin datos sensibles (R43). */
  private log(row: OutboxRow, traceId: string, status: string, detail = ''): void {
    this.logger.log(
      `onnix-sync eventType=${row.event_type} ticketId=${row.aggregate_id} status=${status} traceId=${traceId}${
        detail ? ` detail=${detail}` : ''
      }`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
