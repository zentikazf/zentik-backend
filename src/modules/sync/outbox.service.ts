import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import {
  EnqueueInput,
  OutboxEventType,
  OutboxRow,
} from './types/outbox.types';

/**
 * Filtros de recuperacion de la DLQ (#51 R3.2, D4). Estructuralmente compatible
 * con `RequeueFailedDto`, pero declarado aca a proposito: es el contrato de
 * consulta del repositorio, no de la capa HTTP (un cron o un script podrian
 * usarlo sin pasar por el controller, y la regla del 400 los alcanza igual).
 */
export interface RequeueFilters {
  /** Ids puntuales. Solo se consideran los que esten en `failed`. */
  ids?: string[];
  /** Todas las `failed` de este tipo de evento. */
  eventType?: OutboxEventType;
  /** Solo las que cayeron por el simulacro (`lastError` empieza con DRY_RUN). */
  onlyDryRun?: boolean;
}

/**
 * Evento interno de baja latencia (#50 R4): "se escribio una fila en el outbox".
 * Lo escucha SyncDispatcherService para agendar el drenado con debounce. Es un
 * trigger best-effort, NUNCA fuente de verdad (la verdad es la fila; el cron
 * sigue siendo la red de seguridad).
 */
export const OUTBOX_ENQUEUED_EVENT = 'outbox.enqueued';

/**
 * Resultado de una escritura CONDICIONADA a que la fila siga siendo nuestra
 * (#51 FIX B/C). Todas las escrituras terminales del drenado (`markSynced`,
 * `markFailed`, `release`) y el refresco del lock (`renewClaimLock`) llevan
 * `status: 'in_flight'` en el `where`:
 *
 * - `'applied'`: el UPDATE toco la fila — seguiamos siendo dueños del claim.
 * - `'lost'`: el UPDATE no toco NADA. La fila ya no esta `in_flight`: otro
 *   drenado la rescato (su lock vencio) y hoy es suya. Este drenado tiene que
 *   soltarla, no pisarla.
 *
 * Union de strings y no booleano a proposito: en el call site `=== 'lost'` dice
 * QUE paso, mientras que un `if (!ok)` obliga a ir a leer la firma para saber si
 * el `ok` era "escribio" o "fallo".
 */
export type OutboxWriteOutcome = 'applied' | 'lost';

/**
 * `externalId` centinela para la fila COMMENT_ADDED cuyo mensaje se borro entre
 * el encolado y el drenado (#51 FIX D).
 *
 * El skip por mensaje borrado marca la fila `synced` sin haber posteado nada. Con
 * `externalId = null` esa fila quedaba contando como "sincronizada SIN ancla"
 * PARA SIEMPRE (ver `getCommentClaimState`), y `unanchored > 0` DESACTIVA la
 * adopcion del ticket entero: un unico mensaje borrado apagaba el anti-duplicado
 * de ese ticket de forma permanente y cada timeout posterior de OSD en ese ticket
 * duplicaba el comentario.
 *
 * La raiz es que `unanchored` mezclaba dos cosas MUY distintas: "se posteo y no
 * guardamos el ancla" (peligroso: hay un comentario nuestro suelto en OSD, hay que
 * desactivar la adopcion) y "nunca se posteo" (inofensivo: no hay nada suelto). El
 * centinela separa las dos: dice explicitamente "esta fila no tiene comentario en
 * OSD que anclar". Nunca puede colisionar con un id real de OSD —que es numerico y
 * el dedup compara contra `String(c.id)`—, asi que tenerlo en el set de reclamados
 * no puede bloquear la adopcion de ningun comentario real.
 */
export const SKIPPED_MESSAGE_DELETED_EXTERNAL_ID = 'skipped:message-deleted';

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
   * escucha o el listener falla, la fila sigue en `pending` y el cron la
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
   *
   * ⚠️ RESCATE DE LOCK VENCIDO = REINTENTO (#51 FIX 7): el CASE del `attempts` suma
   * 1 SOLO en la rama del rescate (la fila ya estaba `in_flight` y su lock vencio),
   * y 0 en la rama normal (`pending`). Sin eso, el caso MAS ambiguo de todos —el
   * POST salio y el proceso murio antes del markSynced, o sea cada redeploy de
   * Railway con un drenado en vuelo— volvia con `attempts` en 0, y el chequeo
   * anti-duplicado del dispatcher (gateado justo por `attempts > 0`) lo dejaba
   * pasar por el camino feliz: re-POST a ciegas de un comentario que probablemente
   * ya estaba en OSD. Semanticamente el rescate ES un reintento, asi que ahora el
   * contador lo dice.
   *
   * En Postgres el lado derecho de un `SET` se evalua contra la fila VIEJA, asi que
   * `status` dentro del CASE es el status PRE-update (`pending` o `in_flight`),
   * nunca el `'in_flight'` que estamos escribiendo en la misma sentencia. Y el
   * `RETURNING *` emite la fila NUEVA: el dispatcher ve el attempts ya incrementado,
   * que es exactamente lo que necesita para decidir el dedup.
   */
  async claim(limit: number): Promise<OutboxRow[]> {
    const staleMs = this.config.onnixSyncStaleLockMs;
    return this.prisma.$queryRaw<OutboxRow[]>`
      WITH claimed AS (
        UPDATE outbox_events SET
          status = 'in_flight',
          locked_at = now(),
          attempts = attempts + CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END
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
   * Refresca `locked_at` de la fila que el drenado esta por procesar (#51 FIX C).
   *
   * ⚠️ POR QUE EXISTE: `claim` estampa `locked_at` UNA sola vez para las hasta
   * `batchSize` (50) filas del lote, asi que el reloj del lock corre POR LOTE. Con
   * OSD lento el presupuesto real es enorme —cada call aborta a los 15s y una fila
   * en reintento paga GET + POST—, de modo que la ultima fila del lote puede
   * empezar a procesarse ~25 minutos despues del claim, muy por encima de
   * ONNIX_SYNC_STALE_LOCK_MS (120s). En esa ventana otro drenado la ve como lock
   * vencido, la rescata y la postea MIENTRAS el primero todavia la tiene en memoria
   * y tambien la va a postear: comentario duplicado en OSD, que no tiene delete.
   *
   * Refrescando el lock justo antes de tocar la fila, el reloj pasa a correr POR
   * FILA: el rescate solo puede ocurrir si ESA fila lleva de verdad mas de
   * STALE_LOCK_MS sin avanzar. Es un UPDATE por PK, indexado y barato.
   *
   * Devuelve `'lost'` cuando la fila ya no esta `in_flight` (otro drenado se la
   * llevo): el caller debe SALTEARLA. Es WARN y no ERROR a proposito — no se
   * pierde nada, la fila la esta procesando el otro drenado; el WARN existe porque
   * dos drenados solapados sobre la misma fila siguen siendo una anomalia que el
   * operador tiene que poder ver.
   */
  async renewClaimLock(id: string): Promise<OutboxWriteOutcome> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id, status: 'in_flight' },
      data: { lockedAt: new Date() },
    });
    if (count > 0) return 'applied';
    this.logger.warn(
      `onnix-sync renewClaimLock: la fila ${id} ya no esta in_flight ` +
        `(otro drenado la rescato tras vencer su lock) — este drenado la saltea ` +
        `para no procesarla dos veces en paralelo`,
    );
    return 'lost';
  }

  /**
   * Marca una fila como sincronizada con exito (R14). Persiste el `externalId`
   * (code de Onnix en TICKET_CREATED, id del comentario de OSD en COMMENT_ADDED)
   * cuando aplica.
   *
   * ⚠️ CONDICIONADA a `status: 'in_flight'` (#51 FIX B). Era un `update` por id a
   * secas —"la fila ya fue reclamada, no hay lock que ganar"—, y esa premisa es
   * FALSA en cuanto dos drenados se solapan: si el lock de esta fila vencio, otro
   * drenado la rescato, la posteo y la dejo `synced` con SU `externalId`; cuando el
   * drenado viejo termina, su `update` por id pisa ese ancla con el id del SEGUNDO
   * POST. El comentario del PRIMER POST queda en OSD sin ninguna fila que lo
   * reclame — y como huerfano con `unanchored === 0` el dedup lo considera
   * ADOPTABLE: una fila posterior con el mismo texto lo adopta, se da por enviada y
   * NUNCA postea su mensaje. Perdida silenciosa, el peor final posible. Con el
   * `where` de estado el que llega tarde no escribe nada y se entera.
   */
  async markSynced(
    id: string,
    externalId?: string | null,
  ): Promise<OutboxWriteOutcome> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id, status: 'in_flight' },
      data: {
        status: 'synced',
        syncedAt: new Date(),
        ...(externalId ? { externalId } : {}),
      },
    });
    return this.reportOwnership(count, id, 'markSynced');
  }

  /**
   * Marca un fallo. `terminal=true` → `failed` (poison message / 422 / cliente no
   * mapeado). `terminal=false` → `attempts++` y vuelve a `pending` para reintento
   * (5xx/red/timeout mientras no se alcance el cap). El cap a `failed` lo decide
   * el caller comparando attempts contra ONNIX_SYNC_MAX_ATTEMPTS (R30-R32).
   *
   * ⚠️ Condicionada a `status: 'in_flight'` por el mismo motivo que `markSynced`
   * (#51 FIX B): un drenado que perdio la fila no puede devolver a `pending` —ni
   * mandar a la DLQ— algo que otro drenado ya sincronizo. Sin la guarda, un
   * `markFailed` tardio resucitaba una fila YA posteada y el proximo ciclo la
   * volvia a postear (duplicado), o la enterraba en `failed` haciendo que un
   * requeue manual la posteara de nuevo.
   */
  async markFailed(
    id: string,
    error: string,
    terminal: boolean,
  ): Promise<OutboxWriteOutcome> {
    const lastError = error.slice(0, 5000);
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id, status: 'in_flight' },
      data: terminal
        ? { status: 'failed', lastError, lockedAt: null }
        : {
            status: 'pending',
            lastError,
            attempts: { increment: 1 },
            lockedAt: null,
          },
    });
    return this.reportOwnership(count, id, `markFailed(terminal=${terminal})`);
  }

  /**
   * Traduce el `count` de una escritura condicionada a `in_flight` (#51 FIX B) y
   * deja el rastro cuando la fila ya no era nuestra.
   *
   * ERROR y no WARN: `count === 0` en una escritura TERMINAL significa que dos
   * drenados corrieron solapados sobre la misma fila y que este proceso hizo
   * trabajo real (probablemente un POST a OSD) cuyo resultado NO quedo registrado
   * en ninguna parte. Es exactamente la condicion que produce comentarios
   * huerfanos en OSD, asi que tiene que ser visible/alertable, no un warning mas.
   */
  private reportOwnership(
    count: number,
    id: string,
    op: string,
  ): OutboxWriteOutcome {
    if (count > 0) return 'applied';
    this.logger.error(
      `onnix-sync ${op}: la fila ${id} ya no estaba in_flight al escribir el ` +
        `resultado (otro drenado la rescato tras vencer su lock). NO se escribio ` +
        `nada: pisarla dejaria un comentario real de OSD sin dueño. Si este ciclo ` +
        `llego a postear, revisa el ticket a mano — puede haber quedado un ` +
        `comentario huerfano en OSD.`,
    );
    return 'lost';
  }

  /**
   * Re-encola filas `failed` (reconciliacion R39): vuelve a `pending` y resetea
   * attempts/lastError para reintentar (p. ej. cliente que paso a estar mapeado).
   * Devuelve el numero de filas re-encoladas.
   *
   * ⚠️ COMMENT_ADDED se resetea a 1, NO a 0 (#51 FIX 6). El `attempts` cumple DOS
   * roles a la vez: es el presupuesto de reintentos (cap contra
   * ONNIX_SYNC_MAX_ATTEMPTS) y es la señal "esta fila ya salio a la ruta" que gatea
   * el chequeo anti-duplicado del dispatcher (`row.attempts > 0`). Resetear a 0
   * borraba el segundo rol junto con el primero: la fila re-encolada volvia a
   * entrar por el camino feliz y POSTEABA A CIEGAS — y son justo las filas que
   * llegaron al cap tras N timeouts ambiguos, o sea las que tienen la probabilidad
   * MAS ALTA de estar ya en OSD. Con el endpoint de requeue de #51 eso pasa a ser
   * una operacion de un click.
   *
   * Un 1 es el minimo cambio que no mezcla los dos roles: conserva la señal y gasta
   * un solo intento del presupuesto (que ademas subio a 8 en #51 FIX 11). Los otros
   * eventTypes siguen en 0: `createTicket`, `setEstado` y `assignTicket` (#52) son
   * idempotentes por diseño —los tres son last-write-wins sobre el mismo recurso, no
   * agregan una linea nueva a la conversacion como el comentario—, no tienen dedup
   * que gatear y no ganan nada perdiendo un intento.
   *
   * Dos updateMany a proposito (no uno con CASE): Prisma no expresa un SET
   * condicional sin `$executeRaw`, y partir por eventType deja el invariante
   * legible en el where. Ambos conservan `status: 'failed'` — segunda reja contra
   * un drain que pase entre el SELECT de resolucion y este UPDATE.
   */
  async requeueFailed(rowIds: string[]): Promise<number> {
    if (rowIds.length === 0) return 0;
    const base = { id: { in: rowIds }, status: 'failed' };
    const resetData = { status: 'pending', lastError: null, lockedAt: null };
    const [others, comments] = await Promise.all([
      this.prisma.outboxEvent.updateMany({
        where: { ...base, eventType: { not: 'COMMENT_ADDED' } },
        data: { ...resetData, attempts: 0 },
      }),
      this.prisma.outboxEvent.updateMany({
        where: { ...base, eventType: 'COMMENT_ADDED' },
        data: { ...resetData, attempts: 1 },
      }),
    ]);
    return others.count + comments.count;
  }

  /**
   * Resuelve los filtros del endpoint de requeue (#51 R3.2/R3.3, D4) a la lista de
   * ids `failed` que corresponde re-encolar. Vive aca —y no en el controller—
   * porque este service es el repositorio de `outbox_events` (misma frontera de
   * capa que `claim`/`requeueFailed`): el controller no arma `where` de Prisma.
   *
   * - Los filtros se combinan con AND. `ids` + `eventType` + `onlyDryRun` juntos
   *   devuelven la interseccion.
   * - `status: 'failed'` NO es negociable y va siempre: el requeue es recuperacion
   *   de la DLQ. Una fila `pending`/`in_flight` esta viva y tocarla desde afuera
   *   pisaria un drenado en curso. `requeueFailed` vuelve a filtrar por `failed`
   *   (defensa en profundidad: entre el SELECT y el UPDATE puede pasar un drain).
   * - `onlyDryRun: false` NO restringe nada, asi que NO cuenta como filtro: mandarlo
   *   solo sigue cayendo en el 400 de abajo.
   *
   * Sin ningun filtro tira 400 explicito (R3.2): re-encolar la DLQ entera de un
   * saque no puede ser el default de un endpoint que se invoca a mano en prod.
   */
  async resolveFailedIdsForRequeue(filters: RequeueFilters): Promise<string[]> {
    const byIds = filters.ids !== undefined && filters.ids.length > 0;
    const byEventType = filters.eventType !== undefined;
    const byDryRun = filters.onlyDryRun === true;

    if (!byIds && !byEventType && !byDryRun) {
      throw new AppException(
        'Especifica al menos un filtro (ids, eventType u onlyDryRun) para re-encolar. ' +
          'Re-encolar toda la DLQ de una vez no esta permitido por accidente.',
        'SYNC_REQUEUE_NO_FILTERS',
        400,
      );
    }

    const rows = await this.prisma.outboxEvent.findMany({
      where: {
        status: 'failed',
        ...(byIds ? { id: { in: filters.ids } } : {}),
        ...(byEventType ? { eventType: filters.eventType } : {}),
        // Mismo marcador que escribe el dispatcher al simular (`DRY_RUN: simulacro,
        // no enviado a Onnix`) y que la alerta de DLQ ya descarta con este prefijo.
        ...(byDryRun ? { lastError: { startsWith: 'DRY_RUN' } } : {}),
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Devuelve una fila `in_flight` a `pending` SIN incrementar attempts. Para el
   * ordering gate (R24): un STATUS_CHANGED que aun no puede enviarse (su
   * TICKET_CREATED todavia no tiene code) se libera para reintentar el proximo
   * ciclo, sin contar como fallo.
   *
   * ⚠️ Condicionada a `status: 'in_flight'` por el mismo motivo que `markSynced`
   * (#51 FIX B): si otro drenado rescato la fila y ya la posteo, un `release`
   * tardio la devolveria a `pending` y el proximo ciclo la POSTEARIA DE NUEVO.
   */
  async release(id: string): Promise<OutboxWriteOutcome> {
    const { count } = await this.prisma.outboxEvent.updateMany({
      where: { id, status: 'in_flight' },
      data: { status: 'pending', lockedAt: null },
    });
    return this.reportOwnership(count, id, 'release');
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

  /**
   * Estado de "contabilidad" de los comentarios ya sincronizados de un ticket
   * (#51 R2.2 condicion 2 / D2.2 paso 3, ampliado por FIX 5).
   *
   * Devuelve DOS cosas de una sola query sobre las filas COMMENT_ADDED `synced` del
   * mismo `aggregate_id`:
   *
   * - `claimedIds`: los `externalId` no-null, o sea los ids de comentario de OSD que
   *   YA tienen dueño (una outbox-row nuestra los reclamo).
   * - `unanchored`: cuantas de esas filas quedaron SIN `externalId`.
   *
   * ⚠️ `claimedIds` es lo que hace SEGURO el dedup por texto, no un extra. Sin el,
   * dos mensajes identicos del mismo autor en el mismo ticket ("ok", "gracias",
   * "dale") son indistinguibles: la segunda fila encontraria el "ok" de la primera,
   * se daria por enviada y PERDERIAMOS un mensaje. Perder es mucho peor que
   * duplicar. Con la marca de "reclamado", el "ok" de la primera fila ya tiene dueño
   * y no confunde a la segunda.
   *
   * ⚠️ `unanchored > 0` significa literalmente "NO tenemos contabilidad completa de
   * los comentarios de este ticket": hay comentarios nuestros en OSD que no sabemos
   * cuales son. En ese estado el conjunto de "no reclamados" que ve el dedup incluye
   * comentarios que en realidad YA son nuestros, y adoptar uno de ellos = dar por
   * enviado un mensaje que nunca salio = PERDERLO en silencio (OSD no tiene update
   * ni delete de comentario: no hay como arreglarlo despues). Por eso el dispatcher
   * usa este contador para DESACTIVAR la adopcion y postear: duplicar se ve a ojo y
   * se limpia, perder no.
   *
   * De donde salen las filas sin ancla: (a) las COMMENT_ADDED sincronizadas ANTES de
   * #51, cuando nadie persistia el `externalId`; (b) un 200/201 sin id utilizable en
   * el body (el contrato roto que FIX 8 loggea).
   *
   * ⚠️ Ese residual NO se cierra solo (correccion de #51 FIX D — el comentario
   * anterior afirmaba lo contrario y era FALSO). Una fila vieja sin ancla no gana un
   * `externalId` nunca: las filas nuevas suman anclas pero no borran a las viejas,
   * asi que el contador sigue en >0 y el dedup de ESE ticket queda desactivado
   * mientras esas filas existan. Se asume: son tickets que ya tenian comentarios
   * antes de #51, el estado degradado postea (duplicado recuperable) en vez de
   * perder, y esta gritado en el WARN del dispatcher.
   *
   * ⚠️ Lo que SI se elimino es la fuente que crecia sola: el skip por mensaje
   * borrado marcaba `synced` con `externalId = null` y sumaba una fila sin ancla
   * PARA SIEMPRE por cada mensaje que un usuario borrara — un solo borrado apagaba
   * el anti-duplicado del ticket entero. Ahora esa fila lleva el centinela
   * `SKIPPED_MESSAGE_DELETED_EXTERNAL_ID`, asi que cuenta como ANCLADA: es la
   * verdad (no hay comentario suelto en OSD que ella deberia reclamar) y el
   * centinela dentro de `claimedIds` es inofensivo, porque los ids de OSD son
   * numericos y el dedup compara contra `String(c.id)` — jamas va a matchear.
   *
   * UNA sola query y la particion en JS (FIX 5): antes se filtraba `externalId: { not
   * null }` en el where, asi que las filas sin ancla eran invisibles — no se podian
   * ni contar. Traer las dos clases juntas cuesta lo mismo y hace observable el
   * estado degradado. Usa el indice `[aggregateId, createdAt]` que ya existe (#13) —
   * sin migracion.
   */
  async getCommentClaimState(
    aggregateId: string,
  ): Promise<{ claimedIds: string[]; unanchored: number }> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: {
        aggregateId,
        eventType: 'COMMENT_ADDED',
        status: 'synced',
      },
      select: { externalId: true },
    });

    const claimedIds: string[] = [];
    let unanchored = 0;
    for (const row of rows) {
      // null/'' (defensivo: un externalId vacio no ancla nada) cuenta como fila sin
      // ancla, no como id reclamado — un '' en el Set haria matchear cualquier cosa.
      if (row.externalId) claimedIds.push(row.externalId);
      else unanchored += 1;
    }
    return { claimedIds, unanchored };
  }
}
