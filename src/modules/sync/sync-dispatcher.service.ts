import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import {
  OutboxService,
  OUTBOX_ENQUEUED_EVENT,
  SKIPPED_MESSAGE_DELETED_EXTERNAL_ID,
} from './outbox.service';
import { OnnixClientService } from './onnix-client.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OnnixUpstreamError } from './errors';
import { DrainResult, OutboxRow } from './types/outbox.types';
import { OnnixCreateTicketBody } from './types/onnix.types';
import { ASSIGN_REASON_MAX_LEN } from './onnix-user-map';

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
 * Cadencia del cron del drenador: cada 20 minutos (formato de 6 campos, con
 * segundos → :00, :20 y :40 de cada hora).
 *
 * Fijo en el codigo A PROPOSITO, sin env var (antes era
 * `process.env.ONNIX_SYNC_CRON ?? '0 0 * * * *'`): el servidor no tiene que
 * configurar nada para que el deploy quede con la cadencia correcta, y no hay
 * forma de que una variable olvidada en Railway le gane al codigo y deje la red
 * de seguridad en una hora sin que nadie se entere.
 *
 * Por que 20 minutos y no una hora: con #50 el cron CAMBIO DE TRABAJO. Antes era
 * el camino de latencia (una hora alcanzaba para replicar tickets); ahora la
 * latencia la resuelve el drain-on-enqueue y el cron paso a ser el camino de
 * RECUPERACION — el que levanta lo que se perdio cuando la pista en memoria se
 * evaporo (restart en la ventana del debounce, listener caido, fila devuelta a
 * `pending`, comentario esperando en el ordering gate). Una red que tarda hasta
 * 60 min en darse cuenta es demasiado para una conversacion. Un ciclo en vacio
 * son dos queries indexadas (el claim que devuelve 0 filas + el chequeo de DLQ),
 * asi que bajarlo es practicamente gratis.
 */
const SYNC_CRON = '0 */20 * * * *';
/**
 * Espera del drenado de seguimiento cuando quedaron filas REINTENTABLES (#51 FIX 4).
 *
 * El debounce de `onnixSyncDrainDebounceMs` (3s) esta pensado para una rafaga de
 * chat: agrupa mensajes nuevos y baja la latencia. Reusarlo para el REINTENTO era
 * un error de categoria: con ONNIX_SYNC_MAX_ATTEMPTS=3 y 3s entre intentos, el cap
 * se quema en ~6-9 SEGUNDOS. Antes de #51 los intentos los espaciaba el cron (20
 * min), asi que una caida corta de OSD costaba UN intento; con el seguimiento
 * corriendo cada 3s un 502 de 60s manda el outbox ENTERO a la DLQ — la feature de
 * "robustez" dejaria al sistema MENOS tolerante a una interrupcion breve.
 *
 * Un minuto es el orden de magnitud de un blip de upstream (deploy, restart,
 * failover) y deja los 3 intentos cubriendo ~2 min de caida sin capear, mientras
 * el cron de 20 min sigue como red de seguridad para lo que dure mas. No es env
 * var a proposito (mismo molde que SHUTDOWN_TIMEOUT_MS / ORDER_GATE_MAX_AGE_MS):
 * es una decision de diseño del reintento, no tuning por entorno.
 */
const RETRY_BACKOFF_MS = 60_000;
/**
 * Resultado del procesamiento de una fila.
 * - `skipped` = ordering gate, no cuenta.
 * - `dry_run` = simulacro (ONNIX_SYNC_DRY_RUN): pipeline completo SIN POST a Onnix;
 *   no cuenta como synced (no hay external_id real) ni como failed real.
 * - `retry` = fallo transitorio que volvio a `pending` con attempts++ (#51 D3). Se
 *   cuenta como `failed` en el DrainResult (es un fallo de este ciclo, y asi lo
 *   reportaba #13/#50), pero se distingue del `failed` TERMINAL porque es la unica
 *   señal de "quedo trabajo pendiente" que dispara el drenado de seguimiento.
 */
type RowOutcome = 'synced' | 'failed' | 'retry' | 'skipped' | 'dry_run';

/**
 * Drenador del outbox → Onnix (feature #13, D2/D5/D7/D10).
 *
 * Disparado por `@Cron` cada 20 min, por el timer del drain-on-enqueue y por el
 * endpoint admin (todos el mismo método `processPending`). `@OnEvent` es solo
 * trigger de baja latencia (best-effort), NUNCA fuente de verdad (R3, R4).
 *
 * ⚠️ UN SOLO DRENADO POR PROCESO (#51 FIX A). Los CUATRO disparadores consultan
 * `this.running` antes de arrancar; `waitForCompletion` del `@Cron` solo cubre al
 * cron contra si mismo. Dos `processPending` solapados eran la raiz de casi todos
 * los caminos de perdida/duplicado de #51: locks que vencen mientras el otro drena,
 * escrituras terminales que pisan filas ajenas, conversacion desordenada en OSD y
 * el `finally` del primero apagando `running` con el otro todavia vivo.
 *
 * Contra el solapamiento ENTRE PROCESOS (dos instancias del backend, un redeploy
 * con superposicion) `running` no puede nada: ahi protegen el claim atomico
 * (`FOR UPDATE SKIP LOCKED`), el refresco de lock por fila y las escrituras
 * condicionadas a `in_flight` de `OutboxService`.
 */
@Injectable()
export class SyncDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(SyncDispatcherService.name);
  private running = false;
  /** Timer del debounce del drain-on-enqueue (#50 R4.1). null = no hay drenado agendado. */
  private drainTimer: NodeJS.Timeout | null = null;
  /**
   * Vencimiento (epoch ms) del timer vigente (#51 FIX 4). Con un solo timer y DOS
   * esperas distintas (debounce corto de rafaga vs backoff largo de reintento) hace
   * falta saber CUANDO vence el que ya esta armado para decidir si el pedido nuevo
   * lo reemplaza: gana siempre el mas CORTO. null cuando no hay timer.
   */
  private drainTimerDueAt: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly outbox: OutboxService,
    private readonly onnix: OnnixClientService,
    private readonly mapping: OnnixMappingService,
  ) {}

  // ── Disparadores ───────────────────────────────────────────────────────────

  /**
   * ⚠️ MISMA guarda que `onTicketEvent` y que el timer del debounce (#51 FIX A).
   * `waitForCompletion` evita que el cron se solape CONSIGO MISMO y nada mas: no
   * sabe del timer del drain-on-enqueue ni del endpoint admin. El cron era el unico
   * disparador que llamaba `processPending()` sin mirar `this.running`, asi que un
   * tick que caia con el drenado del debounce en vuelo arrancaba un SEGUNDO drenado
   * en el mismo proceso — la raiz de casi todos los caminos de perdida/duplicado de
   * #51 (locks que vencen mientras el otro drena, escrituras terminales que pisan
   * filas ajenas, comentarios desordenados en el hilo de OSD, y el `finally` del
   * primero en terminar apagando `running` con el otro todavia vivo).
   *
   * Perder el tick no cuesta nada: el cron vuelve en 20 min y el drenado en vuelo
   * esta procesando la MISMA cola ahora mismo (con su propio seguimiento agendado
   * si quedo trabajo). Por eso retorna a secas y no re-agenda.
   */
  @Cron(SYNC_CRON, {
    name: 'onnix-sync',
    waitForCompletion: true,
  })
  async tick(): Promise<void> {
    if (!this.config.onnixSyncEnabled || this.running) return;
    await this.processPending();
  }

  /**
   * ¿Hay un drenado en vuelo EN ESTE PROCESO? Solo lectura (#51 FIX A): el
   * endpoint admin la consulta para no arrancar un segundo drenado solapado. Se
   * expone como metodo —y no como `public running`— para que nadie pueda escribir
   * la bandera desde afuera: `running` es del ciclo de vida de `processPending`.
   *
   * El chequeo-y-llamada del caller NO tiene ventana de carrera: `processPending`
   * pone `running = true` de forma SINCRONA (antes de su primer `await`), asi que
   * el event loop no puede intercalar un segundo drenado entre el `isDraining()` y
   * el `processPending()` de otro request.
   *
   * Ojo con el alcance: es memoria del proceso, no un lock distribuido. Dos
   * instancias del backend NO se ven entre si; contra eso protege el claim atomico
   * (`FOR UPDATE SKIP LOCKED`) mas el refresco de lock por fila (FIX C).
   */
  isDraining(): boolean {
    return this.running;
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
   * Agenda UN drenado tras `delayMs` (default: el debounce del drain-on-enqueue).
   * Una rafaga de conversacion (varios mensajes seguidos) cae toda dentro de la
   * misma ventana: el primero agenda y los siguientes no adelantan nada → un solo
   * drain para el lote. El anti-solapamiento contra el cron ya lo dan
   * `waitForCompletion` + el claim atomico, no se duplica aca.
   *
   * ⚠️ Hay UN solo timer para dos esperas de proposito opuesto (#51 FIX 4): el
   * debounce corto (3s, latencia de chat) y el backoff del reintento
   * (RETRY_BACKOFF_MS, para no quemar el cap de intentos en segundos). La regla que
   * los concilia es "gana el mas corto":
   * - si ya hay timer y el pedido nuevo vence DESPUES o igual, se ignora (un
   *   reintento NUNCA pisa/atrasa un debounce de rafaga ya agendado);
   * - si vence ANTES, se cancela el vigente y se re-agenda con el mas corto (un
   *   mensaje nuevo durante el backoff sigue saliendo en 3s).
   * Asi el backoff nunca se ADELANTA solo: cuando el drenado de rafaga corre
   * primero, las filas reintentables que sigan fallando vuelven a pedir su propio
   * backoff al cerrar ese ciclo.
   */
  private scheduleDrain(delayMs: number = this.config.onnixSyncDrainDebounceMs): void {
    if (!this.config.onnixSyncEnabled) return;
    const dueAt = Date.now() + delayMs;
    if (this.drainTimer) {
      // `?? 0` defensivo: sin vencimiento conocido no se puede comparar, y adelantar
      // un drenado es inocuo (el claim atomico protege), atrasarlo no.
      if (dueAt >= (this.drainTimerDueAt ?? 0)) return;
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.drainTimerDueAt = dueAt;
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
      // Al re-armar se usa el debounce corto a proposito, aunque este timer viniera
      // del backoff: el drenado en vuelo esta procesando la cola AHORA, asi que lo
      // unico que hace falta es una pasada corta detras de el. Si esas filas siguen
      // fallando, ese ciclo vuelve a pedir su propio RETRY_BACKOFF_MS.
      if (this.running) {
        this.drainTimer = null;
        this.drainTimerDueAt = null;
        this.scheduleDrain();
        return;
      }
      this.drainTimer = null;
      this.drainTimerDueAt = null;
      void this.processPending().catch((e: unknown) =>
        this.logger.warn(
          `drain-on-enqueue falló (el cron lo recupera): ${(e as Error)?.message ?? e}`,
        ),
      );
    }, delayMs);
    // No debe mantener vivo el proceso ni frenar un shutdown limpio; el cron
    // recupera lo que quede pendiente. `?.` porque con fake timers puede faltar.
    this.drainTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    // Timer pendiente = drenado que ya no tiene sentido (el proceso se va).
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
      this.drainTimerDueAt = null;
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
    /** Filas que volvieron a `pending` por fallo transitorio (#51 D3). */
    let retryable = 0;
    /** Filas que quedaron TERMINALES en la DLQ (422, payload corrupto, cap). */
    let terminal = 0;
    /** Filas que el ordering gate libero sin consumir intento (no es trabajo hecho). */
    let skipped = 0;
    /**
     * Filas del lote que dejaron de ser nuestras ANTES de procesarlas (#51 FIX C):
     * el refresco del lock encontro que ya no estaban `in_flight`. No son ni exito
     * ni fallo de este ciclo —las esta procesando otro drenado—, pero son la señal
     * de que hubo solapamiento y por eso viajan al log de cierre.
     */
    let lost = 0;
    /** Tamaño del lote reclamado; fuera del try para decidir el seguimiento. */
    let claimed = 0;
    // Se lee UNA vez: el mismo numero decide el LIMIT del claim y la condicion de
    // "lote lleno". Releerlo abajo compararia contra un valor que pudo cambiar.
    const batchSize = this.config.onnixSyncBatchSize;
    this.running = true;
    try {
      // `claim` devuelve las filas ordenadas por created_at ASC (garantizado por
      // el CTE, ver OutboxService.claim): este loop es secuencial, asi que ese
      // orden ES el orden en que los comentarios aparecen en el hilo de OSD.
      const rows = await this.outbox.claim(batchSize);
      claimed = rows.length;
      for (const row of rows) {
        // Lock POR FILA, no por lote (#51 FIX C). `claim` estampa `locked_at` una
        // sola vez para las hasta `batchSize` filas, asi que el reloj de
        // ONNIX_SYNC_STALE_LOCK_MS (120s) empieza a correr para TODAS al mismo
        // tiempo. Con OSD lento (cada call aborta a los 15s, y una fila en reintento
        // paga GET + POST) la ultima fila de un lote de 50 puede empezar a
        // procesarse ~25 min despues del claim: otro drenado ya la vio como lock
        // vencido, la rescato y la posteo, mientras esta todavia la tiene en memoria
        // y tambien la va a postear → comentario duplicado en OSD, que no tiene
        // delete. Refrescando el lock justo antes de tocarla, el reloj corre por
        // FILA y el rescate solo puede pasar si ESA fila de verdad se colgo.
        //
        // `'lost'` = la fila ya no esta `in_flight`: otro drenado se la llevo y la
        // esta procesando. Saltearla es lo correcto — procesarla igual produce
        // exactamente el duplicado que este refresco vino a evitar, y no se pierde
        // nada porque el otro drenado la termina.
        if ((await this.outbox.renewClaimLock(row.id)) === 'lost') {
          lost++;
          continue;
        }
        let outcome: RowOutcome;
        try {
          outcome = await this.processRow(row, traceId);
        } catch (err) {
          outcome = await this.handleUpstreamFailure(row, err);
        }
        if (outcome === 'synced') result.synced++;
        // `retry` cuenta como failed hacia afuera (el contrato de DrainResult no
        // cambia) pero se lleva su propio contador para el drenado de seguimiento.
        else if (outcome === 'failed') {
          result.failed++;
          terminal++;
        } else if (outcome === 'retry') {
          result.failed++;
          retryable++;
        } else if (outcome === 'dry_run') dryRun++;
        else skipped++;
      }
      await this.checkDlqAge();
    } finally {
      this.running = false;
    }
    // Drenado de seguimiento (#51 R4.1/D3). Sin esto, al sacar el reintento
    // intra-drain del comentario (D2.3) un blip de OSD dejaria el mensaje esperando
    // hasta el proximo cron — justo lo que #50 R4 vino a eliminar. Reusa
    // `scheduleDrain` (mismo timer, misma guarda de re-armado, misma limpieza en el
    // shutdown) y aplica a TODOS los eventTypes.
    //
    // ⚠️ La condicion mira si el ciclo hizo TRABAJO UTIL, no solo si el lote volvio
    // lleno (#51 FIX 3). El `claimed === batchSize` a secas era un busy-loop: un lote
    // LLENO de filas que el ordering gate libera (`skipped`) lo cumple sin haber
    // avanzado nada → claim de 50, 50 release, "synced=0 failed=0", re-agenda a los
    // 3s, y otra vez. Son ~28.800 ciclos y ~2,9M de escrituras muertas por dia contra
    // la DB, durante las 24h que tarda el fondo de pozo del gate en declararlas
    // terminales; pre-#51 ese mismo estado costaba UN ciclo cada 20 min. Peor: con
    // `batchSize = 0` (una env var DEFINIDA PERO VACIA en Railway da `Number('') === 0`
    // y pasa la validacion) `0 === 0` re-agendaba para siempre con la cola muerta —
    // por eso tambien se exige `claimed > 0`.
    //
    // Dos motivos legitimos, con esperas distintas:
    // - `retryable > 0`: quedaron filas en `pending` por un transitorio. Va con
    //   RETRY_BACKOFF_MS, NO con el debounce: a 3s el cap de intentos se quema en
    //   segundos y una caida corta de OSD manda todo a la DLQ (#51 FIX 4).
    // - lote lleno Y con avance real (`synced + terminal + dryRun > 0`): hay backlog
    //   y la cola se esta moviendo. Va con el debounce normal (es latencia, no
    //   reintento).
    // Un lote que solo tuvo `skipped` NO agenda nada: esas filas no consumieron
    // intento y su TICKET_CREATED las despierta via notifyEnqueued cuando se cree.
    // Va DESPUES del `finally` (running ya en false) y antes del log de cierre.
    const progressed = result.synced + terminal + dryRun;
    if (retryable > 0) {
      this.scheduleDrain(RETRY_BACKOFF_MS);
    } else if (claimed > 0 && claimed === batchSize && progressed > 0) {
      this.scheduleDrain();
    }
    if (dryRun > 0) result.dryRun = dryRun;
    this.logger.log(
      `onnix-sync drain done traceId=${traceId} synced=${result.synced} failed=${result.failed}` +
        (dryRun > 0 ? ` dryRun=${dryRun}` : '') +
        // claimed/skipped/retryable no cambian el contrato de DrainResult, pero son
        // la unica forma de leer en los logs el estado que causaba el busy-loop
        // (claimed=batchSize con skipped=batchSize = cola tapada por el gate).
        // `lost` > 0 significa que OTRO drenado se llevo filas de este lote: es el
        // sintoma directo de dos drenados solapados y la primera cosa que hay que
        // mirar si aparece un comentario duplicado en OSD.
        ` claimed=${claimed} skipped=${skipped} retryable=${retryable} lost=${lost}`,
    );
    return result;
  }

  private async processRow(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    if (row.event_type === 'TICKET_CREATED') return this.processCreate(row, traceId);
    if (row.event_type === 'STATUS_CHANGED') return this.processStatus(row, traceId);
    if (row.event_type === 'COMMENT_ADDED') return this.processComment(row, traceId);
    if (row.event_type === 'ASSIGNEE_CHANGED') return this.processAssign(row, traceId);
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
      // #52 R2.1: la asignación de Zentik vive en la task (`TaskAssignment`), no en
      // el ticket. Se trae acá para que el ticket pueda NACER en OSD con su
      // responsable en vez de quedar a nombre del usuario de servicio.
      // `orderBy` explícito: el ticket es single-assignee pero su task es una task
      // normal del kanban y acepta varios. Sin orden, dos drenados de la misma fila
      // podían elegir responsables distintos.
      include: {
        task: {
          select: {
            assignments: { select: { userId: true }, orderBy: { userId: 'asc' } },
          },
        },
      },
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

    // #52 R2.1/R2.2: responsable con el que nace el ticket en OSD. `resolveUserId`
    // devuelve null tanto si el ticket no tiene asignado como si ese usuario no
    // está mapeado, y las DOS ramas terminan igual: el body sale SIN `assigned_to`,
    // idéntico al de hoy. Nunca se falla un create por esto — un ticket sin
    // responsable en OSD se arregla a mano; un ticket que no se creó, no.
    const assignedTo = await this.mapping.resolveUserId(
      ticket.organizationId,
      ticket.task?.assignments[0]?.userId,
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
      // `typeof === 'number'` y no `!== null`: si el mapeo devolviera `undefined`
      // (contrato roto), `!== null` dejaria pasar un `assigned_to: undefined` al
      // body en vez de omitir el campo. La forma positiva solo agrega el campo
      // cuando de verdad hay un id.
      ...(typeof assignedTo === 'number' ? { assigned_to: assignedTo } : {}),
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
          // #52 R5.3: el QA en dry-run tiene que poder ver si el responsable viaja.
          // 'sin-mapeo' cubre las dos ramas de R2.2 (sin asignado / sin mapping):
          // en las dos el body sale sin `assigned_to`, que es justo lo que se valida.
          `assigned_to=${body.assigned_to ?? 'sin-mapeo'} ` +
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

  // ── ASSIGNEE_CHANGED (#52) ───────────────────────────────────────────────────

  /**
   * Refleja en OSD el responsable del ticket (`POST /tickets/{code}/asignar`) — #52 R3.3.
   *
   * ⚠️ ESTE HANDLER ES LA EXCEPCION AL MANEJO 4xx DEL DISPATCHER. En todos los demas
   * eventTypes un 422 es TERMINAL y la fila cae a la DLQ; acá NO. El rol
   * `integracion` de OSD solo puede asignar a miembros de su propio equipo y dentro
   * de su producto, y cuando el destinatario queda fuera de ese cerco OSD responde
   * 422. Eso NO es un defecto nuestro: es un limite de permisos CONOCIDO, esperado y
   * que ningun reintento ni requeue puede arreglar. Mandarlo a la DLQ llenaria la
   * cola de filas incurables y haria sonar `checkDlqAge` por algo sano, tapando los
   * fallos de verdad.
   *
   * La regla rectora de #50/#51 ("perder es peor que duplicar") NO aplica acá — es al
   * revés (decision cerrada 3). Un comentario que no viaja es conversacion PERDIDA;
   * una asignacion que no viaja solo deja el ticket a nombre del usuario de servicio,
   * exactamente como estaba antes de #52. Degradacion honesta, visible en el warn.
   *
   * Los TRES caminos que cierran la fila sin llamar a OSD (sin responsable, sin
   * mapping, 422 del cerco) usan `markSynced` y NO `markFailed`: la fila esta
   * terminada, no fallida. `markFailed` la dejaria en `failed`, o sea en la DLQ, que
   * es justo lo que R3.3 prohibe.
   */
  private async processAssign(row: OutboxRow, traceId: string): Promise<RowOutcome> {
    // 1. Ordering gate (R3.3) — PRIMERO, antes de leer nada: no se puede asignar un
    // ticket que todavia no existe en OSD. Mismo mecanismo que STATUS_CHANGED y
    // COMMENT_ADDED, con el fondo de pozo de 24h de #51.
    const code = await this.outbox.getCreatedExternalId(row.aggregate_id);
    if (!code) return this.handleOrderingGateMiss(row, traceId);

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: row.aggregate_id },
      select: {
        organizationId: true,
        // Mismo `orderBy` que `updateTicket` y que `processCreate`: si la task
        // quedó con varios asignados desde el kanban, los tres tienen que estar de
        // acuerdo en cuál es "el" responsable, o el que viaja a OSD depende de qué
        // devolvió el heap en esa lectura.
        task: {
          select: {
            assignments: { select: { userId: true }, orderBy: { userId: 'asc' } },
          },
        },
      },
    });
    if (!ticket) {
      await this.outbox.markFailed(row.id, `ticket ${row.aggregate_id} no existe`, true);
      return 'failed';
    }

    // 2. Responsable ACTUAL (R3.2), no snapshot: si hubo N reasignaciones seguidas
    // se envia la final. Igual que STATUS_CHANGED — acá solo importa el estado
    // final, a diferencia de las notas internas (#50 R3.2), donde cada version
    // intermedia es una linea distinta en la conversacion y por eso SI se snapshotea.
    const assigneeId = ticket.task?.assignments[0]?.userId ?? null;
    if (!assigneeId) {
      // Desasignado en Zentik (R3.3). OSD NO tiene desasignacion: `assigned_to` es
      // OBLIGATORIO en `/asignar`, asi que no hay nada que mandar. LIMITACION
      // DOCUMENTADA: OSD conserva el ultimo responsable. Se cierra la fila con log
      // —no hay reintento que lo arregle— y sin ensuciar la DLQ.
      await this.outbox.markSynced(row.id);
      this.log(
        row,
        traceId,
        'skipped',
        'ticket sin responsable en Zentik (OSD no tiene desasignacion; conserva el ultimo)',
      );
      return 'skipped';
    }

    // 3. Mapping del responsable (R3.3). Sin par en OSD → skip con warn, NUNCA DLQ.
    const assignedTo = await this.mapping.resolveUserId(
      ticket.organizationId,
      assigneeId,
    );
    // `typeof !== 'number'` y no `=== null`: un `undefined` (contrato roto del
    // mapeo) tiene que caer en el skip, NO seguir de largo y mandarle a OSD un
    // `assigned_to: undefined` que solo puede terminar en 422.
    if (typeof assignedTo !== 'number') {
      this.logger.warn(
        `onnix-sync ASSIGNEE_CHANGED skipeado: el responsable ${assigneeId} no tiene mapping ` +
          `de usuario en onnix_entity_mappings. El ticket queda en OSD con el responsable ` +
          `anterior. Corre POST /admin/sync/onnix/seed-users y revisa la lista ` +
          `"zentikUsersWithoutPair" del reporte. ticketId=${row.aggregate_id} code=${code} ` +
          `traceId=${traceId}`,
      );
      await this.outbox.markSynced(row.id);
      this.log(row, traceId, 'skipped', `responsable sin mapping: ${assigneeId}`);
      return 'skipped';
    }

    const reason = await this.buildAssignReason(row.payload.assignedByUserId);

    // Modo simulacro (R5.3): se resolvio code + assigned_to + reason, NO se hace el
    // POST. La fila se marca terminal-no-loop con texto DRY_RUN (mismo molde que el
    // resto). NO se reafirma el estado: sin POST, OSD no movio nada.
    if (this.config.onnixSyncDryRun) {
      this.logger.warn(
        `onnix-sync DRY_RUN (simulacro, NO enviado a Onnix) eventType=${row.event_type} ` +
          `ticketId=${row.aggregate_id} code=${code} assigned_to=${assignedTo} ` +
          `zentikAssigneeId=${assigneeId} reason=${reason} traceId=${traceId}`,
      );
      await this.outbox.markFailed(row.id, 'DRY_RUN: simulacro, no enviado a Onnix', true);
      return 'dry_run';
    }

    try {
      // CON retryWithJitter, igual que `createTicket`/`setEstado` y a diferencia de
      // `addComment`: asignar es idempotente por diseño (last-write-wins sobre un
      // solo campo), asi que un reintento inmediato ante un 5xx es gratis. Repetir
      // una asignacion no agrega nada al hilo que el cliente ve.
      const outcome = await this.retryWithJitter(() =>
        this.onnix.assignTicket(code, { assigned_to: assignedTo, reason }, traceId),
      );
      if (outcome.ok) {
        await this.outbox.markSynced(row.id);
        this.log(row, traceId, 'synced', `assigned_to=${assignedTo}`);
        // R3.4: OSD mueve el ticket a "asignado" al asignar. Se reafirma el estado
        // DESPUES de cerrar la fila, para que un fallo de la reafirmacion no pueda
        // revertir una asignacion que YA ocurrio.
        await this.reassertStatusAfterAssign(row, ticket.organizationId, code, traceId);
        return 'synced';
      }

      // ⚠️ EL 422: SKIP CON WARN, NUNCA DLQ (R3.3).
      //
      // Aplica a TODO 422 de este endpoint, no solo a los que digan la frase exacta
      // del cerco, y es deliberado. La alternativa —matchear "no es de tu equipo" /
      // "otro producto" y mandar el resto a la DLQ, como hace STATUS_CHANGED con el
      // "ya esta en ese estado"— apuesta a la redaccion literal de un mensaje en
      // español de OSD: el dia que le cambien una palabra o un acento, el 422
      // esperable se convierte en la fila envenenada que R3.3 vino a evitar, y nadie
      // se entera hasta que suena la alerta de la DLQ. Ahí el default tiene el signo
      // opuesto (terminal por defecto, la frase es el ESCAPE), acá el default seguro
      // es skipear: ningun 422 de `/asignar` se arregla reintentando, y el peor caso
      // es que OSD conserve el responsable anterior.
      //
      // El mensaje CRUDO de OSD viaja en el warn, asi que un 422 inesperado (un
      // `assigned_to` que ya no existe, un ticket cerrado del lado de OSD) sigue
      // siendo 100% diagnosticable — solo que desde los logs y no desde la DLQ.
      this.logger.warn(
        `onnix-sync ASSIGNEE_CHANGED rechazado por OSD con 422 → skip (NO va a la DLQ). ` +
          `Causa tipica: el cerco del rol de integracion (el responsable no es de su equipo ` +
          `o el ticket es de otro producto). El ticket queda en OSD con el responsable ` +
          `anterior. ticketId=${row.aggregate_id} code=${code} assigned_to=${assignedTo} ` +
          `mensajeOSD="${(outcome.message ?? '').slice(0, 500)}" traceId=${traceId}`,
      );
      await this.outbox.markSynced(row.id);
      this.log(row, traceId, 'skipped', `422 del cerco de OSD (assigned_to=${assignedTo})`);
      return 'skipped';
    } catch (err) {
      return this.handleUpstreamFailure(row, err);
    }
  }

  /**
   * Arma el `reason` que OSD guarda en su auditoria de asignacion (#52 R3.3).
   *
   * El actor sale del SNAPSHOT del payload (`assignedByUserId`), no de una
   * relectura: es el unico dato del evento que el drenado no puede reconstruir —el
   * ticket no guarda "quien fue el ultimo que reasigno"— y ademas no cambia nunca
   * para esta fila. Mismo molde que el prefijo de autor de la nota interna (#50 R3.3).
   *
   * Truncado a ASSIGN_REASON_MAX_LEN: un nombre largo no puede convertir una
   * asignacion valida en un 422 de validacion por `maxLength`.
   */
  private async buildAssignReason(assignedByUserId?: string): Promise<string> {
    const actor = assignedByUserId
      ? await this.prisma.user.findUnique({
          where: { id: assignedByUserId },
          select: { name: true },
        })
      : null;
    const name = actor?.name || UNKNOWN_AUTHOR;
    return `Sincronizado desde Zentik — asignado por ${name}`.slice(
      0,
      ASSIGN_REASON_MAX_LEN,
    );
  }

  /**
   * Reafirma el estado del ticket despues de una asignacion exitosa (#52 R3.4).
   *
   * POR QUE EXISTE: OSD mueve el ticket al estado "asignado" como efecto colateral
   * del `/asignar`. Si Zentik dice "en proceso", OSD queda mostrando "asignado" y el
   * cliente ve el ticket RETROCEDIDO — sin que ningun evento de Zentik lo explique,
   * porque del lado nuestro el estado no cambio. Es el modo de fallo mas confuso de
   * toda la integracion: la UI de OSD contradice a la de Zentik y los logs de sync
   * dicen "synced".
   *
   * Se ENCOLA una fila `STATUS_CHANGED` en vez de llamar `setEstado` inline, y eso es
   * a proposito: la fila hereda gratis todo lo que ya existe —reintentos con su
   * propio backoff, el 422 "ya esta en ese estado" tratado como exito idempotente
   * (por eso reafirmar es barato), el cap de intentos y la DLQ—. Inline, un blip de
   * OSD en la reafirmacion obligaria a elegir entre perderla o fallar una fila cuya
   * asignacion YA se aplico.
   *
   * Se reafirma SIEMPRE, sin comparar contra el estado de OSD: saberlo costaria un
   * GET extra por asignacion, y el 422 idempotente ya hace que la reafirmacion
   * redundante sea inofensiva.
   *
   * NUNCA lanza: la fila de asignacion ya esta `synced` y su POST ya se aplico en
   * OSD. Un fallo acá es un ERROR loggeado, nunca un rollback de algo irreversible.
   */
  private async reassertStatusAfterAssign(
    row: OutboxRow,
    organizationId: string,
    code: string,
    traceId: string,
  ): Promise<void> {
    try {
      // `this.prisma` como cliente: `enqueueTx` es un unico `create`, asi que fuera
      // de una tx es igual de atomico. Se reusa —en vez de escribir un insert
      // propio— para no duplicar el gate de flag/whitelist de orgs que vive adentro.
      const wrote = await this.outbox.enqueueTx(this.prisma, {
        eventType: 'STATUS_CHANGED',
        aggregateId: row.aggregate_id,
        organizationId,
        payload: { ticketId: row.aggregate_id },
      });
      if (!wrote) return;
      // La fila nace DESPUES del claim de este drenado, asi que este ciclo no la ve.
      // El aviso la hace salir en segundos en vez de esperar al cron (el timer se
      // re-arma solo si hay un drenado en vuelo, ver `scheduleDrain`).
      this.outbox.notifyEnqueued();
      this.log(row, traceId, 'synced', `reafirmacion de estado encolada (code=${code})`);
    } catch (err) {
      this.logger.error(
        `onnix-sync asignacion APLICADA pero la reafirmacion de estado no se pudo encolar: ` +
          `OSD puede quedar en "asignado" mientras Zentik dice otra cosa. ` +
          `ticketId=${row.aggregate_id} code=${code} traceId=${traceId} ` +
          `error=${(err as Error)?.message ?? 'desconocido'}`,
      );
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
        //
        // ⚠️ CON CENTINELA (#51 FIX D). Marcarla `synced` con `externalId = null`
        // la dejaba, para siempre, como una fila COMMENT_ADDED sincronizada SIN
        // ancla; `getCommentClaimState` la contaba en `unanchored`, y `unanchored >
        // 0` DESACTIVA la adopcion del ticket ENTERO. O sea: un unico mensaje
        // borrado apagaba el anti-duplicado de ese ticket de forma permanente, y a
        // partir de ahi cada timeout de OSD en ese ticket duplicaba el comentario.
        // El centinela dice la verdad —"esta fila nunca posteo nada, no hay
        // comentario de OSD que anclar"— y no puede colisionar con un id real (los
        // de OSD son numericos), asi que dentro del set de reclamados es inerte.
        await this.outbox.markSynced(row.id, SKIPPED_MESSAGE_DELETED_EXTERNAL_ID);
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
      // Chequeo anti-duplicado (#51 R2.2/D2.2), SOLO en reintentos. `attempts > 0`
      // significa que esta fila ya salio a la ruta y volvio con un fallo AMBIGUO: un
      // timeout NO prueba que OSD no haya procesado el POST (rawFetch aborta a los
      // 15s y clasifica como transitorio). Antes de re-postear preguntamos si
      // nuestro comentario ya esta alla. En el camino feliz (attempts === 0) esto no
      // corre: el drenado normal no paga ni una request extra (R2.4).
      if (row.attempts > 0) {
        const orphan = await this.findUnclaimedComment(
          code,
          row,
          comment,
          isInternal,
          traceId,
        );
        // `!= null` (no `!== null`) a proposito: si alguna vez vuelve `undefined`
        // —un comentario de OSD sin `id`, contrato roto—, `!== null` lo dejaba pasar
        // y se grababa el literal 'undefined' como externalId: la fila queda `synced`
        // sin haber posteado NADA (mensaje perdido) y encima ese externalId basura
        // envenena el dedup del ticket para siempre. El predicado de abajo ya exige
        // `typeof id === 'number'`; esto es la segunda linea de defensa.
        if (orphan != null) {
          // Era nuestro POST perdido: se adopta en vez de duplicarlo. El id queda
          // reclamado por ESTA fila, asi que ninguna otra lo va a confundir.
          await this.outbox.markSynced(row.id, String(orphan));
          this.log(
            row,
            traceId,
            'synced',
            `dedup: el POST anterior si habia llegado (osdId=${orphan})`,
          );
          return 'synced';
        }
        // No hay huella del intento anterior → se re-postea. Es el unico momento en
        // que puede nacer un duplicado (R2.7: un humano escribio en OSD el mismo
        // texto con prefijo incluido, o OSD lo acepto y no lo devuelve en el GET),
        // asi que queda un WARN rastreable con todo lo necesario para auditarlo a
        // mano (#51 R2.6/D2.6). NUNCA el cuerpo: es conversacion del cliente.
        this.logger.warn(
          `onnix-sync re-post de comentario tras fallo ambiguo (posible duplicado) ` +
            `ticketId=${row.aggregate_id} code=${code} rowId=${row.id} ` +
            `attempts=${row.attempts} traceId=${traceId}`,
        );
      }

      // SIN retryWithJitter a proposito (#51 R2.3/D2.3): un solo camino de reintento.
      // El intra-drain corria con `row.attempts` todavia en 0 —el punto ciego del
      // chequeo de arriba— y disparaba a los ~300ms, con OSD probablemente todavia
      // procesando el primer POST: era el reintento con MAS probabilidad de duplicar.
      // Ahora un transitorio va derecho a handleUpstreamFailure (fila → pending,
      // attempts++) y el proximo drenado —que D3 agenda en segundos— entra por D2.2.
      // `createTicket` y `setEstado` lo CONSERVAN: son idempotentes por diseño.
      const outcome = await this.onnix.addComment(
        code,
        comment,
        isInternal,
        traceId,
        // Idempotency-Key (#51 R2.5/D2.4): el id de la fila. OSD hoy lo ignora.
        row.id,
      );
      if (outcome.ok) {
        // Se persiste el id del comentario de OSD como externalId (#51 R2.1/D2.1):
        // el 201 ya lo trae, cuesta cero y es EL ancla de todo el dedup — a partir de
        // aca cada comentario nuestro en OSD tiene dueño. No afecta a
        // `getCreatedExternalId`, que filtra por eventType 'TICKET_CREATED'.
        // El ternario cubre el 200 sin body (contrato roto): markSynced sin id sigue
        // siendo correcto —la fila SI se sincronizo—, solo queda sin ancla.
        const osdId =
          outcome.data?.id !== undefined ? String(outcome.data.id) : undefined;
        const written = await this.outbox.markSynced(row.id, osdId);
        // La fila dejo de ser nuestra entre el POST y el markSynced (#51 FIX B): el
        // comentario SI existe en OSD pero su ancla no se pudo guardar en ningun
        // lado. `OutboxService` ya loggeo el ERROR generico; aca se agrega lo unico
        // que el operador necesita para re-anclarlo a mano (que id de OSD quedo
        // suelto y en que ticket), porque ese huerfano es justo el que puede
        // envenenar el dedup del ticket mas adelante.
        if (written === 'lost') {
          this.logger.error(
            `onnix-sync comentario POSTEADO pero SIN anclar: la fila ${row.id} ya no era ` +
              `nuestra al marcarla synced. ticketId=${row.aggregate_id} code=${code} ` +
              `osdId=${osdId ?? 'desconocido'} traceId=${traceId}`,
          );
        }
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
   * Busca en OSD un comentario que sea el POST perdido de ESTA fila (#51 D2.2).
   * Devuelve su `id` o `null` si hay que postear.
   *
   * ⚠️ REGLA RECTORA (R2): PERDER UN MENSAJE ES MUCHO PEOR QUE DUPLICARLO. OSD no
   * tiene delete ni update de comentario, asi que un duplicado se resuelve a ojo
   * pero un mensaje que no se postea se pierde para siempre Y EN SILENCIO (la fila
   * queda `synced`). Por eso TODA duda —dato faltante, contabilidad incompleta,
   * campo que no vino— resuelve a `null`: se postea.
   *
   * Adoptar exige que se cumplan TODAS estas condiciones:
   * 1. `comment` IDENTICO al texto que ibamos a mandar (prefijo de autor incluido).
   * 2. `id` numerico. Con `String(c.id)` un comentario sin `id` daba 'undefined',
   *    jamas estaba en el set de reclamados y por lo tanto SIEMPRE matcheaba por
   *    texto — el peor caso posible del predicado.
   * 3. Ese `id` NO esta reclamado como `externalId` por otra outbox-row
   *    COMMENT_ADDED `synced` del mismo ticket. Sin esto, dos mensajes identicos del
   *    mismo autor ("ok", "gracias", "dale" — el 80% de una conversacion de soporte)
   *    son indistinguibles: la segunda fila encontraria el "ok" de la primera y se
   *    daria por enviada.
   * 4. MISMA visibilidad (`is_internal`). El prefijo de una nota interna de un admin
   *    y el de su mensaje de chat son IDENTICOS (`[Juan] `), asi que sin esto una
   *    fila puede adoptar un comentario de visibilidad OPUESTA: la nota interna se
   *    contabiliza contra el mensaje publico y el cliente nunca ve el suyo. Si OSD
   *    no devuelve el campo, NO hay match (no se adivina la visibilidad).
   * 5. Ventana temporal: `created_at` del comentario >= `created_at` de la fila. Un
   *    comentario ANTERIOR a la existencia de la fila no puede ser su POST perdido.
   *    Sin fecha o con fecha que no parsea, NO es candidato.
   *
   * Ademas, si el ticket tiene comentarios nuestros SIN ancla (`externalId` null:
   * filas sincronizadas antes de #51 o un 200 sin body), el dedup se DESACTIVA
   * entero para ese aggregate: la contabilidad de reclamos esta incompleta y no hay
   * forma de distinguir "huerfano porque se perdio mi POST" de "huerfano porque
   * nadie anoto quien es su dueño".
   *
   * ⚠️ Ese estado degradado NO "se reactiva solo" (lo decia este comentario y era
   * FALSO — #51 FIX D). Una fila vieja sin ancla no adquiere `externalId` jamas: las
   * filas nuevas suman anclas propias pero no arreglan a las viejas, asi que el
   * contador queda en >0 y el ticket se queda sin adopcion mientras existan. Lo
   * unico que se corrigio es la fuente que CRECIA sola: el skip por mensaje borrado
   * marcaba `synced` sin externalId y sumaba una fila sin ancla por cada mensaje
   * que un usuario borrara — un solo borrado apagaba el dedup del ticket para
   * siempre. Ahora esa fila lleva `SKIPPED_MESSAGE_DELETED_EXTERNAL_ID` y cuenta
   * como anclada. El residual que queda (tickets con comentarios previos a #51, o
   * un 200 sin body) es acotado y su efecto es POSTEAR: duplicado recuperable a
   * ojo, nunca perdida.
   *
   * Si `listComments` falla, la excepcion sube al catch de `processComment` →
   * `handleUpstreamFailure`: no se postea a ciegas cuando no se pudo preguntar.
   */
  private async findUnclaimedComment(
    code: string,
    row: OutboxRow,
    comment: string,
    isInternal: boolean,
    traceId: string,
  ): Promise<number | null> {
    // ⚠️ SECUENCIAL, no `Promise.all` (#51 FIX 2). En paralelo el snapshot de
    // reclamos es de t0 y el de OSD de t0+latencia (rawFetch aborta recien a los
    // 15s). Un comentario que OTRO drenado postea y marca `synced` DENTRO de esa
    // ventana aparece en el listado de OSD pero no en los reclamos → se ve huerfano,
    // esta fila lo adopta y el mensaje de esta fila se pierde. Preguntando a OSD
    // PRIMERO y leyendo los reclamos DESPUES, todo lo que exista en el listado ya
    // tuvo su chance de estar reclamado. Cuesta un round-trip de DB en el camino de
    // reintento, que ya paga un GET a OSD.
    const remote = await this.onnix.listComments(code, traceId);
    const state = await this.outbox.getCommentClaimState(row.aggregate_id);

    if (state.unanchored > 0) {
      this.logger.warn(
        `onnix-sync dedup DESACTIVADO para ticketId=${row.aggregate_id}: ` +
          `${state.unanchored} comentario(s) sincronizado(s) sin externalId (sin ancla). ` +
          `La contabilidad de reclamos esta incompleta, asi que un comentario "libre" en OSD ` +
          `puede ser de otra fila y adoptarlo perderia este mensaje: se postea (posible duplicado, ` +
          // Sin "se reactiva solo" a proposito (#51 FIX D): esas filas no van a ganar
          // un externalId nunca, asi que el ticket queda con el dedup apagado hasta
          // que alguien ancle o limpie esas filas a mano.
          `recuperable a ojo). NO se reactiva solo: esas filas no van a ganar un externalId, ` +
          `hay que anclarlas o limpiarlas a mano si se quiere el dedup de vuelta en este ticket. ` +
          `rowId=${row.id} code=${code} traceId=${traceId}`,
      );
      return null;
    }

    // Set de strings: `externalId` es texto en la DB y el id de OSD es numero.
    const claimedIds = new Set(state.claimedIds);
    // `new Date(...)` defensivo: la fila viene de $queryRaw crudo.
    const rowCreatedAtMs = new Date(row.created_at).getTime();

    const match = remote.find((c) => {
      if (typeof c.id !== 'number') return false;
      if (c.comment !== comment) return false;
      // Comparacion estricta contra el booleano: `undefined !== true/false`, asi que
      // un OSD que no devuelva el campo cae solo del lado de "no match".
      if (c.is_internal !== isInternal) return false;
      if (claimedIds.has(String(c.id))) return false;
      // Estricto a proposito: si OSD trunca el timestamp a segundos, un comentario
      // nuestro puede quedar milisegundos "antes" que la fila y no ser candidato.
      // Ese error resuelve a POSTEAR (duplicado recuperable), que es el lado
      // correcto de la regla rectora; aflojarlo abre la puerta a adoptar un
      // comentario preexistente y perder el mensaje.
      const remoteMs = c.created_at ? new Date(c.created_at).getTime() : NaN;
      if (Number.isNaN(remoteMs) || remoteMs < rowCreatedAtMs) return false;
      return true;
    });
    return match === undefined ? null : match.id;
  }

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
   *
   * Devuelve `retry` cuando la fila volvio a `pending` (queda trabajo) y `failed`
   * cuando capeo y quedo TERMINAL en la DLQ (#51 D3). Esa distincion es la que
   * dispara —o no— el drenado de seguimiento: re-agendar por una fila que ya es
   * terminal seria un drenado en vacio en bucle. Hacia afuera las dos siguen
   * contando como `failed` en el DrainResult.
   */
  private async handleUpstreamFailure(
    row: OutboxRow,
    err: unknown,
  ): Promise<'failed' | 'retry'> {
    const reason =
      err instanceof OnnixUpstreamError
        ? `${err.upstreamStatus} ${err.upstreamReason ?? ''}`.trim()
        : ((err as Error)?.message ?? 'error desconocido');
    const willCap = row.attempts + 1 >= this.config.onnixSyncMaxAttempts;
    await this.outbox.markFailed(row.id, reason.slice(0, 4000), willCap);
    if (willCap) {
      this.logger.warn(`onnix-sync fila ${row.id} alcanzó el cap de intentos → failed`);
      return 'failed';
    }
    return 'retry';
  }

  /**
   * Reintento intra-drain con backoff exponencial + jitter (R33) SOLO para
   * transitorios (5xx/red/timeout). No modifica `common/utils/retry.ts` (global).
   * Los 422/401-auth no son transitorios y se propagan/clasifican afuera.
   *
   * ⚠️ Lo usan `createTicket` y `setEstado`, NUNCA `addComment` (#51 R2.3/D2.3).
   * Esos dos son idempotentes ante un timeout —la creacion tiene el guard de
   * `external_id` y el estado es last-write-wins—, asi que un reintento inmediato
   * es gratis. Un comentario NO: cada POST que llega es una linea mas en la
   * conversacion que ve el cliente, y OSD no tiene delete de comentario.
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
