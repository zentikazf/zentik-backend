/**
 * Tipos del outbox de sync Onnix (feature #13).
 *
 * El outbox es el registro durable de cambios de tickets que deben replicarse a
 * Onnix. La fila nace DENTRO de la `$transaction` que crea/actualiza el ticket
 * (R1); EventEmitter2 solo dispara el drenado (best-effort), nunca es origen (R3).
 */

/**
 * Tipo de evento de negocio capturado en el outbox.
 * `COMMENT_ADDED` (#50 R2.1/R3.1) cubre los DOS origenes de comentario — mensaje
 * del chat y nota interna — porque ambos terminan en el mismo endpoint de OSD
 * (`POST /tickets/{code}/comentarios`); lo unico que cambia es `is_internal` y
 * de donde sale el texto (ver OutboxPayload).
 */
/**
 * Lista RUNTIME de los eventTypes, y unica fuente de verdad de `OutboxEventType`.
 *
 * Es un `as const` y no solo un type union (#52) porque el union no existe en
 * runtime y habia UN consumidor que necesitaba la lista de verdad: el `@IsIn` del
 * DTO de requeue, que la tenia COPIADA a mano. Esa copia ya se habia desincronizado
 * al agregar `ASSIGNEE_CHANGED`: una fila de asignacion en la DLQ —el caso normal
 * del rollout, donde el simulacro de `ONNIX_SYNC_DRY_RUN` manda TODO a `failed`— no
 * se podia re-encolar por tipo, el endpoint respondia 400 y el operador se quedaba
 * sin el camino de recuperacion documentado. Derivando el type de la lista, agregar
 * un eventType nuevo actualiza la validacion sola.
 */
export const OUTBOX_EVENT_TYPES = [
  'TICKET_CREATED',
  'STATUS_CHANGED',
  'COMMENT_ADDED',
  'ASSIGNEE_CHANGED',
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/** Ciclo de vida de una outbox-row. */
export type OutboxStatus = 'pending' | 'in_flight' | 'synced' | 'failed';

/**
 * Payload tipado de una outbox-row. Solo guarda lo necesario para construir la
 * llamada a Onnix (R7); el estado ACTUAL del ticket se lee al drenar (R22), no
 * se snapshotea aqui.
 */
export interface OutboxPayload {
  ticketId: string;
  /** Solo en TICKET_CREATED: cliente/proyecto Zentik para resolver el mapeo. */
  clientId?: string;
  projectId?: string | null;

  // ── COMMENT_ADDED (#50) ────────────────────────────────────────────────────
  /**
   * Chat (R2.2): id del Message. El dispatcher lo RELEE al drenar — mismo criterio
   * que el resto del outbox (el estado actual es la verdad). Si el mensaje ya no
   * existe se skipea con log, no es un fallo.
   */
  messageId?: string;
  /**
   * Nota interna (R3.2): SNAPSHOT del texto. NUNCA se relee el ticket al drenar.
   * Motivo: dos guardados rapidos generan DOS filas; si ambas releyeran el valor
   * final, OSD recibiria el mismo texto dos veces y se perderia la version
   * intermedia. Con snapshot, OSD guarda el historial fiel de versiones.
   */
  adminNoteSnapshot?: string;
  /** Nota interna: autor que guardo, para el prefijo del comentario (R3.3). */
  authorUserId?: string;

  // ── ASSIGNEE_CHANGED (#52) ─────────────────────────────────────────────────
  /**
   * Actor que hizo el cambio de responsable (#52 R3.3), para el `reason` que queda
   * en la auditoria de OSD ("asignado por <nombre>"). Es el UNICO dato snapshoteado
   * de este evento y es correcto que lo sea: el actor de ESTA fila no cambia nunca,
   * mientras que el asignado se RELEE al drenar (R3.2, last-write-wins).
   *
   * Molde exacto de `authorUserId` de la nota interna; campo aparte a proposito para
   * que un payload nunca signifique dos cosas segun el eventType.
   */
  assignedByUserId?: string;
}

/**
 * Input de `enqueueTx`. Molde de `WriteEventInput` de TicketEventsService.
 *
 * `organizationId` se usa SOLO para el gate de scoping multi-tenant en `enqueueTx`
 * (no-op si la org no esta habilitada en `ONNIX_SYNC_ORG_IDS`); no se persiste en
 * la fila (el mapeo se resuelve al drenar leyendo `ticket.organizationId`).
 */
export interface EnqueueInput {
  eventType: OutboxEventType;
  aggregateId: string; // ticket.id (cuid)
  organizationId: string; // scoping multi-tenant (gate de enqueueTx)
  payload: OutboxPayload;
}

/**
 * Fila del outbox tal como vuelve de `RETURNING *` (snake_case crudo de Postgres).
 * El claim usa `$queryRaw` y Postgres devuelve los nombres de columna sin mapear,
 * por eso este tipo es snake_case (a diferencia del modelo Prisma camelCase).
 */
export interface OutboxRow {
  id: string;
  event_type: OutboxEventType;
  aggregate_id: string;
  payload: OutboxPayload;
  payload_version: number;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  external_id: string | null;
  locked_at: Date | null;
  created_at: Date;
  synced_at: Date | null;
}

/** Resultado de un drain (cron o endpoint manual). */
export interface DrainResult {
  synced: number;
  failed: number;
  /**
   * Filas procesadas en modo simulacro (ONNIX_SYNC_DRY_RUN=true): se resolvio el
   * mapeo y se construyo el body pero NO se hizo el POST a Onnix. NO cuentan como
   * synced (no hay external_id real) ni como failed real (no es un defecto). Solo
   * presente cuando hubo al menos una fila en dry-run.
   */
  dryRun?: number;
}
