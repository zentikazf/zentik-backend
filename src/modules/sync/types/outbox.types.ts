/**
 * Tipos del outbox de sync Onnix (feature #13).
 *
 * El outbox es el registro durable de cambios de tickets que deben replicarse a
 * Onnix. La fila nace DENTRO de la `$transaction` que crea/actualiza el ticket
 * (R1); EventEmitter2 solo dispara el drenado (best-effort), nunca es origen (R3).
 */

/** Tipo de evento de negocio capturado en el outbox. */
export type OutboxEventType = 'TICKET_CREATED' | 'STATUS_CHANGED';

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
}
