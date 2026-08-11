import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OutboxService, OUTBOX_ENQUEUED_EVENT } from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { DrainResult, OutboxRow } from './types/outbox.types';
import { OnnixCreateTicketBody } from './types/onnix.types';

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** Limite duro de `comment` en Onnix (OpenAPI: maxLength 10000) — #50 R2.3. */
const COMMENT_MAX_LEN = 10_000;
/**
 * Fondo del pozo del ordering gate (#50). El gate libera la fila SIN consumir
 * intento mientras el TICKET_CREATED todavia no tiene code — correcto y deseado,
 * porque el caso normal se resuelve segundos despues. El problema es el ticket que
 * NUNCA va a tener code (dry-run del rollout, tickets abiertos previos a #13 que
 * por diseño no se backfillean, o un TICKET_CREATED terminal por "cliente no
 * mapeado"): esa fila entraba en un bucle infinito pending→in_flight→pending, no
 * llegaba nunca a OSD, no caia a `failed` y `checkDlqAge` (que solo mira
 * status='failed') no la veia → perdida 100% silenciosa. Peor: el claim ordena por
 * created_at ASC con LIMIT, asi que esas filas viejas se quedaban en la CABEZA de
 * la cola y con ≥batchSize acumuladas cada drenado reclamaba solo zombies y la
 * integracion entera moria en silencio ("drain done synced=0 failed=0").
 * Pasado este tope la fila se declara terminal: sale de pending, libera la cabeza
 * de la cola y se vuelve visible/alertable en la DLQ. No es env var a proposito
 * (molde de SHUTDOWN_TIMEOUT_MS): no es tuning por entorno, es un fondo de pozo.
 */
const ORDER_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Fallback de nombre para el prefijo cuando el autor no tiene nombre cargado. */
const UNKNOWN_AUTHOR = 'Usuario';
/**
 * Resultado del procesamiento de una fila.
 * - `skipped` = ordering gate, no cuenta.
 * - `dry_run` = simulacro (ONNIX_SYNC_DRY_RUN): pipeline completo SIN POST a Onnix;
 *   no cuenta como synced (no hay external_id real) ni como failed real.
 */
type RowOutcome = 'synced' | 'failed' | 'skipped' | 'dry_run';

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
  /** Timer del debounce del drain-on-enqueue (#50 R4.1). null = no hay drenado agendado. */
  private drainTimer: NodeJS.Timeout | null = null;

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

  /**
   * Drain-on-enqueue (#50 R4.1): una fila recien commiteada despierta el drenado
   * en segundos, no en la proxima hora. Lo emite `OutboxService.notifyEnqueued()`
   * DESPUES del commit (R4.3), nunca dentro de la tx.
   */
  @OnEvent(OUTBOX_ENQUEUED_EVENT)
  onOutboxEnqueued(): void {
    this.scheduleDrain();
  }

  /**
   * Agenda UN drenado tras el debounce. Una rafaga de conversacion (varios
   * mensajes seguidos) cae toda dentro de la misma ventana: el primero agenda y
   * los siguientes salen por el `if (this.drainTimer)` → un solo drain para el
   * lote. El anti-solapamiento contra el cron ya lo dan `waitForCompletion` + el
   * claim atomico, no se duplica aca.
   */
  private scheduleDrain(): void {
    if (!this.config.onnixSyncEnabled) return;
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      // Guarda de solapamiento (#50): el timer no consultaba `running` (a
      // diferencia de `onTicketEvent`) y ponia `drainTimer = null` ANTES de
      // arrancar, asi que un notify posterior armaba otro timer que disparaba a
      // los 3s con el drenado anterior todavia en vuelo. Dos `processPending`
      // solapados = dos lotes de comentarios posteandose en paralelo (la
      // conversacion vuelve a desordenarse en OSD, anulando el orden que garantiza
      // el claim) y el `finally` del que termina primero pone `running = false`
      // mientras el otro sigue vivo, desarmando la guarda de `onModuleDestroy`.
      // Retornar a secas NO alcanza: se perderia el disparo hasta el proximo cron
      // → se RE-ARMA el timer. Cada re-armado crea un timer nuevo con `unref`, y
      // `drainTimer` siempre apunta al vigente, asi que el `clearTimeout` de
      // `onModuleDestroy` lo sigue cortando aunque el drenado se cuelgue.
      if (this.running) {
        this.drainTimer = null;
        this.scheduleDrain();
        return;
      }
      this.drainTimer = null;
      void this.processPending().catch((e: unknown) =>
        this.logger.warn(
          `drain-on-enqueue falló (el cron lo recupera): ${(e as Error)?.message ?? e}`,
        ),
      );
    }, this.config.onnixSyncDrainDebounceMs);
    // No debe mantener vivo el proceso ni frenar un shutdown limpio; el cron
    // recupera lo que quede pendiente. `?.` porque con fake timers puede faltar.
    this.drainTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    // Timer pendiente = drenado que ya no tiene sentido (el proceso se va).
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
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
    let dryRun = 0;
    this.running = true;
    try {
      // `claim` devuelve las filas ordenadas por created_at ASC (garantizado por
      // el CTE, ver OutboxService.claim): este loop es secuencial, asi que ese
      // orden ES el orden en que los comentarios aparecen en el hilo de OSD.
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
        else if (outcome === 'dry_run') dryRun++;
      }
      await this.checkDlqAge();
    } finally {
      this.running = false;
    }
    if (dryRun > 0) result.dryRun = dryRun;
    this.logger.log(
      `onnix-sync drain done traceId=${traceId} synced=${result.synced} failed=${result.failed}` +
        (dryRun > 0 ? ` dryRun=${dryRun}` : ''),
    );
    return result;
  }

  private async processRow(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    if (row.event_type === 'TICKET_CREATED') return this.processCreate(row, traceId);
    if (row.event_type === 'STATUS_CHANGED') return this.processStatus(row, traceId);
    if (row.event_type === 'COMMENT_ADDED') return this.processComment(row, traceId);
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

    const clientId = await this.mapping.resolveClientId(
      ticket.organizationId,
      ticket.clientId,
    );
    if (clientId === null) {
      this.log(row, traceId, 'failed', `cliente no mapeado: ${ticket.clientId}`);
      await this.outbox.markFailed(
        row.id,
        `cliente no mapeado en onnix_entity_mappings: ${ticket.clientId}`,
        true,
      );
      return 'failed';
    }
    const projectId = await this.mapping.resolveProjectId(
      ticket.organizationId,
      ticket.projectId,
    );
    // #50 R1.1: el tipo REAL del arbol entra en la cascada (nodo → padre →
    // default de hoy). `ticketTypeId` nulo (historico/edge) cae al default y
    // nunca hace fallar la fila (R1.5).
    const catalogIds = await this.mapping.resolveCatalogIds(
      ticket.organizationId,
      ticket.category,
      ticket.priority,
      traceId,
      ticket.ticketTypeId,
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

    // Modo simulacro (R27/R43): pipeline completo resuelto, NO se hace el POST a
    // Onnix. Se loggea SOLO el body de mapeo (sin subject/description para no
    // exponer datos de cliente) y la fila se marca terminal-no-loop con texto
    // DRY_RUN — NO queda con un external_id falso, claramente NO sincronizada.
    if (this.config.onnixSyncDryRun) {
      this.logger.warn(
        `onnix-sync DRY_RUN (simulacro, NO enviado a Onnix) eventType=${row.event_type} ` +
          `ticketId=${row.aggregate_id} aggregate_id=${row.aggregate_id} ` +
          `client_id=${body.client_id} project_id=${body.project_id ?? 'null'} ` +
          `ticket_type_id=${body.ticket_type_id} ticket_category_id=${body.ticket_category_id} ` +
          `ticket_priority_id=${body.ticket_priority_id} origin=${body.origin ?? 'api'} ` +
          `traceId=${traceId}`,
      );
      await this.outbox.markFailed(
        row.id,
        'DRY_RUN: simulacro, no enviado a Onnix',
        true,
      );
      return 'dry_run';
    }

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
    // No es un fallo: vuelve a pending SIN contar intento; el próximo ciclo lo
    // reintenta después de crear el ticket en Onnix (salvo que sea un zombie —
    // ver `handleOrderingGateMiss`).
    const code = await this.outbox.getCreatedExternalId(row.aggregate_id);
    if (!code) return this.handleOrderingGateMiss(row, traceId);
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

    // Modo simulacro (R27/R43): se resolvio el slug y el code, NO se hace el POST a
    // Onnix. Se loggea slug + code + ticketId + traceId (sin datos sensibles) y la
    // fila se marca terminal-no-loop con texto DRY_RUN.
    if (this.config.onnixSyncDryRun) {
      this.logger.warn(
        `onnix-sync DRY_RUN (simulacro, NO enviado a Onnix) eventType=${row.event_type} ` +
          `ticketId=${row.aggregate_id} code=${code} status_slug=${slug} traceId=${traceId}`,
      );
      await this.outbox.markFailed(
        row.id,
        'DRY_RUN: simulacro, no enviado a Onnix',
        true,
      );
      return 'dry_run';
    }

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

  // ── COMMENT_ADDED (#50) ──────────────────────────────────────────────────────

  /**
   * Envia un comentario a OSD (`POST /tickets/{code}/comentarios`). Un solo
   * eventType para los DOS origenes; lo que cambia es de donde sale el texto:
   *
   * - Nota interna (R3.2): el SNAPSHOT del payload, TAL CUAL. Jamas se relee el
   *   ticket — dos guardados rapidos tienen que producir dos comentarios con
   *   textos DISTINTOS en OSD (si se releyera, el primero viajaria con el texto
   *   final y se perderia la version intermedia). `is_internal: true`.
   * - Chat (R2.2): se RELEE el Message por id (el contenido actual es la verdad).
   *   `is_internal: false`.
   */
  private async processComment(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    // 1. Ordering gate (R2.4) — PRIMERO, antes de leer nada: un comentario no
    // puede viajar si el ticket todavia no existe en OSD. Igual que
    // STATUS_CHANGED: vuelve a pending SIN consumir intento (no es un fallo).
    const code = await this.outbox.getCreatedExternalId(row.aggregate_id);
    if (!code) return this.handleOrderingGateMiss(row, traceId);

    const payload = row.payload;
    let prefix: string;
    let body: string;
    let isInternal: boolean;

    if (payload.adminNoteSnapshot !== undefined) {
      // Nota interna: SNAPSHOT del payload, sin relectura (R3.2).
      body = payload.adminNoteSnapshot;
      isInternal = true;
      const author = payload.authorUserId
        ? await this.prisma.user.findUnique({
            where: { id: payload.authorUserId },
            select: { name: true },
          })
        : null;
      prefix = `[${author?.name || UNKNOWN_AUTHOR}] `;
    } else if (payload.messageId) {
      const message = await this.prisma.message.findUnique({
        where: { id: payload.messageId },
        select: { content: true, user: { select: { name: true, clientId: true } } },
      });
      if (!message) {
        // Mensaje borrado entre el encolado y el drenado (R2.2): NO es un defecto.
        // markSynced (no markFailed) para no ensuciar la DLQ ni disparar la alerta
        // de edad por algo que el usuario deshizo a proposito.
        await this.outbox.markSynced(row.id);
        this.log(row, traceId, 'skipped', 'mensaje inexistente (borrado antes del drenado)');
        return 'skipped';
      }
      body = message.content;
      isInternal = false;
      // Mismo criterio que `senderType` de enrichMessage: user.clientId = cliente.
      const name = message.user?.name || UNKNOWN_AUTHOR;
      prefix = message.user?.clientId ? `[Cliente · ${name}] ` : `[${name}] `;
    } else {
      // Payload corrupto (ni snapshot ni messageId): reintentarlo nunca lo va a
      // arreglar → terminal, a la DLQ.
      await this.outbox.markFailed(
        row.id,
        'payload COMMENT_ADDED sin adminNoteSnapshot ni messageId',
        true,
      );
      return 'failed';
    }

    // Truncado a 10.000 conservando el prefijo (R2.3): se recorta el CUERPO, para
    // que la atribucion del autor no se pierda nunca. Math.max evita el slice
    // negativo si un nombre absurdo se comiera todo el presupuesto.
    const comment = prefix + body.slice(0, Math.max(0, COMMENT_MAX_LEN - prefix.length));

    // Modo simulacro (R5.3): se resolvio code + prefijo + is_internal, NO se hace
    // el POST. Se loggea el PREFIJO y el LARGO (el dueño valida la atribucion en el
    // QA manual) pero NUNCA el cuerpo: es conversacion del cliente.
    if (this.config.onnixSyncDryRun) {
      this.logger.warn(
        `onnix-sync DRY_RUN (simulacro, NO enviado a Onnix) eventType=${row.event_type} ` +
          `ticketId=${row.aggregate_id} code=${code} is_internal=${isInternal} ` +
          `prefix=${prefix.trim()} length=${comment.length} traceId=${traceId}`,
      );
      await this.outbox.markFailed(row.id, 'DRY_RUN: simulacro, no enviado a Onnix', true);
      return 'dry_run';
    }

    try {
      const outcome = await this.retryWithJitter(() =>
        this.onnix.addComment(code, comment, isInternal, traceId),
      );
      if (outcome.ok) {
        await this.outbox.markSynced(row.id);
        this.log(row, traceId, 'synced', `is_internal=${isInternal}`);
        return 'synced';
      }
      // 422 = validacion de Onnix (ticket cerrado, largo, permisos): reintentar no
      // cambia nada → terminal.
      await this.outbox.markFailed(
        row.id,
        `422 Onnix comentario: ${outcome.message ?? ''}`.slice(0, 4000),
        true,
      );
      return 'failed';
    } catch (err) {
      return this.handleUpstreamFailure(row, err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Ordering gate sin code de creacion (R23 / R2.4), compartido por
   * STATUS_CHANGED y COMMENT_ADDED.
   *
   * - Caso NORMAL (fila joven): `release()` — vuelve a pending SIN consumir
   *   intento, exactamente como siempre. Es el mecanismo elegido a proposito: el
   *   TICKET_CREATED se drena segundos despues y la fila sale en el ciclo
   *   siguiente. Esto NO cambia.
   * - Caso ZOMBIE (fila mas vieja que ORDER_GATE_MAX_AGE_MS): el ticket no va a
   *   tener code nunca. Terminal → sale de pending, deja de tapar la cabeza de la
   *   cola (el claim ordena por created_at ASC) y se vuelve visible en la DLQ,
   *   donde `checkDlqAge` si la alerta.
   *
   * Aplica a los DOS eventTypes a proposito: es el mismo bug heredado de #13, y un
   * STATUS_CHANGED sin tope traba la cola igual que un COMMENT_ADDED — arreglar
   * solo uno no arregla nada.
   */
  private async handleOrderingGateMiss(
    row: OutboxRow,
    traceId: string,
  ): Promise<RowOutcome> {
    // `new Date(...)` defensivo: la fila viene de $queryRaw crudo.
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < ORDER_GATE_MAX_AGE_MS) {
      await this.outbox.release(row.id);
      return 'skipped';
    }
    const reason =
      'ordering gate: el ticket no tiene TICKET_CREATED sincronizado en OSD despues de 24h';
    await this.outbox.markFailed(row.id, reason, true);
    this.log(row, traceId, 'failed', reason);
    this.logger.warn(
      `onnix-sync fila ${row.id} (${row.event_type}) supero el tope del ordering gate → failed`,
    );
    return 'failed';
  }

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

  /**
   * Alerta DLQ por edad del mensaje `failed` más viejo (R44).
   *
   * Las filas de simulacro quedan `failed` con lastError 'DRY_RUN: ...' y eso NO es
   * un defecto (es el modo esperado). Como R5.3 manda validar el rollout en prod
   * con ONNIX_SYNC_DRY_RUN=true, sin este filtro la alerta gritaria en cada ciclo
   * por filas sanas y taparia las reales. El `OR lastError=null` es defensivo:
   * `NOT (last_error LIKE 'DRY_RUN%')` en SQL descarta los NULL (NOT NULL = NULL),
   * y una alerta de DLQ no puede perderse por una fila sin mensaje de error.
   */
  private async checkDlqAge(): Promise<void> {
    const oldest = await this.prisma.outboxEvent.findFirst({
      where: {
        status: 'failed',
        OR: [{ lastError: null }, { NOT: { lastError: { startsWith: 'DRY_RUN' } } }],
      },
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
