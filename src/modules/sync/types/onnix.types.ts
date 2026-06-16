/**
 * Tipos del contrato Onnix Support API (Laravel + Sanctum).
 * Anclados al OpenAPI real: docs/integrations/onnix-api-docs.json.
 *
 * Campos en snake_case porque es el wire format de Onnix (NO se renombran).
 */

/** Respuesta de `POST /auth/login`. */
export interface OnnixLoginResponse {
  token: string;
  token_type?: string;
  user?: { id: number; name?: string; email?: string };
}

/** Item de `GET /catalogos/estados`. */
export interface OnnixEstado {
  id: number;
  name: string;
  slug: string;
  color?: string;
  pauses_sla?: boolean;
  is_closed?: boolean;
  is_resolved?: boolean;
}

/** Item generico de catalogo con slug (tipos, categorias, prioridades). */
export interface OnnixCatalogItem {
  id: number;
  name: string;
  slug: string;
  level?: number;
  color?: string;
}

/** Catalogos cacheados que el mapping resuelve por slug. */
export interface OnnixCatalogos {
  estados: OnnixEstado[];
  tipos: OnnixCatalogItem[];
  categorias: OnnixCatalogItem[];
  prioridades: OnnixCatalogItem[];
}

/**
 * Body de `POST /tickets`. Campos obligatorios segun OpenAPI:
 * subject, description, ticket_type_id, ticket_category_id, ticket_priority_id.
 * `client_id` es obligatorio para usuarios internos (la integracion usa cuenta
 * interna). `project_id` nullable.
 */
export interface OnnixCreateTicketBody {
  client_id: number;
  project_id: number | null;
  ticket_type_id: number;
  ticket_category_id: number;
  ticket_priority_id: number;
  subject: string;
  description: string;
  origin?: 'web' | 'email' | 'phone' | 'whatsapp' | 'api' | 'internal';
}

/** Respuesta de `POST /tickets` (TicketDetalle). El `code` es el externalId. */
export interface OnnixTicketDetalle {
  id: number;
  code: string; // TK-YYYY-NNNNNN
  subject?: string;
}

/** Body de `POST /tickets/{code}/estado`. Campo `status_slug` (NO `status`). */
export interface OnnixSetEstadoBody {
  status_slug: string;
  comment?: string;
}

/**
 * Resultado clasificado de una llamada Onnix, devuelto por OnnixClientService al
 * dispatcher para que decida terminal/reintentable/idempotente. El cliente NO
 * lanza para 422 — devuelve el status+message para que el dispatcher clasifique.
 */
export interface OnnixCallOutcome<T> {
  ok: boolean;
  status: number;
  /** Solo presente en ok=true. */
  data?: T;
  /** Mensaje de error de Onnix (para 422); NUNCA se loggea junto con payload. */
  message?: string;
}
