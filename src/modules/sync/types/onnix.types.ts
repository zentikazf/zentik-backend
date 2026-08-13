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
 * Body de `POST /tickets/{code}/comentarios` (#50 R2/R3).
 * `comment` tiene maxLength 10000 en el OpenAPI de Onnix — el dispatcher trunca
 * ANTES de llamar (conservando el prefijo de autor), aca no se valida largo.
 * `is_internal: true` = nota interna (checkbox "solo equipo" de OSD, R3.3).
 */
export interface OnnixAddComentarioBody {
  comment: string;
  is_internal: boolean;
}

/**
 * Respuesta de `POST /tickets/{code}/comentarios` (schema `TicketComentario`).
 * Solo `id` esta garantizado; el resto es informativo y NUNCA se loggea (el
 * `comment` de vuelta es el mismo texto del cliente).
 */
export interface OnnixTicketComentario {
  id: number;
  comment?: string;
  is_internal?: boolean;
  author?: string;
  created_at?: string;
}

/**
 * Envoltorio REAL del 201 de `POST /tickets/{code}/comentarios` (#51 FIX 8).
 *
 * El OpenAPI documenta ese 201 como un `TicketComentario` PELADO, mientras el GET
 * del MISMO path devuelve `{ data: [...] }`. Esa asimetria es la firma tipica de
 * anotaciones Laravel escritas a mano que no reflejan el `JsonResource` real: si el
 * controller devuelve un Resource, la respuesta viene envuelta en `{ data: {...} }`
 * y el OpenAPI simplemente no se actualizo.
 *
 * No podemos apostar a una de las dos formas. Si adivinamos mal, `data.id` es
 * `undefined` SIEMPRE, ninguna fila COMMENT_ADDED queda anclada y el modo de fallo
 * NO es duplicar: es PERDER (el dedup se queda ciego para siempre en ese ticket).
 * Por eso el cliente acepta las dos y desenvuelve.
 *
 * `Partial` a proposito: es lo que llega del cable, no una promesa. El `id` se
 * valida en runtime.
 */
export type OnnixAddComentarioResponse =
  | Partial<OnnixTicketComentario>
  | { data?: Partial<OnnixTicketComentario> };

/**
 * Metadatos de paginacion de un `LengthAwarePaginator` de Laravel (#51 FIX 10).
 * Todos opcionales: si OSD NO pagina, no vienen y no pasa nada.
 */
export interface OnnixPaginationMeta {
  current_page?: number;
  last_page?: number;
  per_page?: number;
  total?: number;
}

/** Links de un paginator de Laravel. `next` no-null ⇒ hay mas paginas (#51 FIX 10). */
export interface OnnixPaginationLinks {
  next?: string | null;
  prev?: string | null;
}

/**
 * Respuesta de `GET /tickets/{code}/comentarios` (#51 D2.2). Onnix (Laravel)
 * envuelve las colecciones en `{ data: [...] }` — a diferencia de los catalogos,
 * que devuelven el array pelado. El cliente desenvuelve y el dispatcher solo ve
 * `OnnixTicketComentario[]`.
 *
 * Se usa para reconocer el POST propio que se perdio en un fallo ambiguo (timeout
 * que NO prueba que OSD no lo haya procesado); NUNCA se loggea el contenido: es
 * conversacion del cliente.
 *
 * `meta`/`links` (#51 FIX 10): `{ data: [...] }` es EXACTAMENTE el envoltorio de un
 * paginator de Laravel, que ademas pagina por default las colecciones grandes. Si
 * OSD pagina, el GET trae solo la primera pagina y el dedup corre sobre una vista
 * PARCIAL del hilo. La direccion del fallo es duplicar (aceptable, R2), pero tiene
 * que ser visible en los logs: no implementamos la paginacion, la detectamos.
 */
export interface OnnixListComentariosResponse {
  data: OnnixTicketComentario[];
  meta?: OnnixPaginationMeta;
  links?: OnnixPaginationLinks;
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
