import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixConfigError, OnnixUpstreamError } from './errors';
import {
  OnnixAddComentarioBody,
  OnnixAddComentarioResponse,
  OnnixAsignarBody,
  OnnixCallOutcome,
  OnnixCatalogItem,
  OnnixCatalogos,
  OnnixCreateTicketBody,
  OnnixEquipoUsuario,
  OnnixEstado,
  OnnixLoginResponse,
  OnnixListComentariosResponse,
  OnnixListEquipoUsuariosResponse,
  OnnixSetEstadoBody,
  OnnixTicketComentario,
  OnnixTicketDetalle,
} from './types/onnix.types';

const DEVICE_NAME = 'zentik-integration';
// TTL conservador del token Sanctum cacheado. Onnix no expone expiry; usamos un
// TTL corto y dejamos que el re-login ante 401 cubra la expiracion real (R26).
const TOKEN_CACHE_KEY = 'onnix:sync:token';
const TOKEN_CACHE_TTL_SEC = 1800; // 30 min

/**
 * Cliente HTTP de Onnix (feature #13).
 *
 * Molde: src/modules/admin-mcp/mcp-client.service.ts:145-184 (fetch nativo +
 * AbortController + timeout por env, sin axios). Clasifica por response.status.
 *
 * Seguridad (R27): NUNCA loggea credenciales, token ni payload — solo metadata
 * (path, status). El token Bearer se cachea en Redis con fallback in-memory (A7).
 */
@Injectable()
export class OnnixClientService {
  private readonly logger = new Logger(OnnixClientService.name);
  /** Fallback in-memory del token si Redis no esta disponible (A7). */
  private memToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  // ── Auth ────────────────────────────────────────────────────────────────

  /**
   * Devuelve un token Bearer valido (cacheado o recien obtenido). Valida en
   * runtime que existan los secretos (solo si el flag esta on; el caller ya
   * verifico el flag). Nunca loggea el token.
   */
  private async getToken(): Promise<string> {
    const cached = await this.readCachedToken();
    if (cached) return cached;
    return this.login();
  }

  private async login(): Promise<string> {
    const baseUrl = this.requireSecret('ONNIX_BASE_URL', this.config.onnixBaseUrl);
    const email = this.requireSecret('ONNIX_EMAIL', this.config.onnixEmail);
    const password = this.requireSecret('ONNIX_PASSWORD', this.config.onnixPassword);

    const res = await this.rawFetch(
      `${baseUrl}/auth/login`,
      'POST',
      { email, password, device_name: DEVICE_NAME },
      undefined,
    );

    if (!res.ok) {
      // Nunca loggear el body (puede reflejar credenciales). Solo el status.
      this.logger.error(`Onnix login fallo status=${res.status}`);
      throw new OnnixUpstreamError(res.status === 401 ? 401 : 502, 'login');
    }

    const body = (await this.parseJson(res)) as OnnixLoginResponse;
    if (!body?.token) {
      throw new OnnixUpstreamError(502, 'login-no-token');
    }
    await this.writeCachedToken(body.token);
    return body.token;
  }

  private requireSecret(name: string, value: string | undefined): string {
    if (!value) {
      // El flag esta on pero falta el secreto: error de runtime, NUNCA del boot.
      throw new OnnixConfigError(name);
    }
    return value;
  }

  private async readCachedToken(): Promise<string | null> {
    try {
      const t = await this.redis.get(TOKEN_CACHE_KEY);
      if (t) return t;
    } catch {
      // Redis caido → fallback in-memory.
    }
    if (this.memToken && this.memToken.expiresAt > Date.now()) {
      return this.memToken.value;
    }
    return null;
  }

  private async writeCachedToken(token: string): Promise<void> {
    this.memToken = { value: token, expiresAt: Date.now() + TOKEN_CACHE_TTL_SEC * 1000 };
    try {
      await this.redis.set(TOKEN_CACHE_KEY, token, 'EX', TOKEN_CACHE_TTL_SEC);
    } catch {
      // Redis caido → ya quedo en memToken.
    }
  }

  private async invalidateToken(): Promise<void> {
    this.memToken = null;
    try {
      await this.redis.del(TOKEN_CACHE_KEY);
    } catch {
      // ignore
    }
  }

  // ── Operaciones de negocio ───────────────────────────────────────────────

  /**
   * Crea un ticket en Onnix. 201 → outcome.ok con `code`. 422 → outcome.ok=false
   * con status/message (el dispatcher lo clasifica como terminal). 5xx/red/timeout
   * lanzan OnnixUpstreamError (reintentable). 401 → re-login 1 vez (R26).
   */
  async createTicket(
    body: OnnixCreateTicketBody,
    traceId: string,
  ): Promise<OnnixCallOutcome<OnnixTicketDetalle>> {
    const res = await this.authedFetch('/tickets', 'POST', body, traceId);
    if (res.status === 201 || res.status === 200) {
      const data = (await this.parseJson(res)) as OnnixTicketDetalle;
      return { ok: true, status: res.status, data };
    }
    if (res.status === 422) {
      return { ok: false, status: 422, message: await this.extractMessage(res) };
    }
    throw new OnnixUpstreamError(res.status, 'create-ticket');
  }

  /**
   * Cambia el estado de un ticket via `POST /tickets/{code}/estado` con body
   * `{ status_slug }` (campo `status_slug`, NUNCA `status`). 200 → ok. 422 →
   * outcome con message (el dispatcher distingue "ya esta en ese estado" =
   * idempotente synced vs slug inexistente = terminal). 5xx → upstream error.
   */
  async setEstado(
    code: string,
    slug: string,
    traceId: string,
  ): Promise<OnnixCallOutcome<OnnixTicketDetalle>> {
    const body: OnnixSetEstadoBody = { status_slug: slug };
    const res = await this.authedFetch(
      `/tickets/${encodeURIComponent(code)}/estado`,
      'POST',
      body,
      traceId,
    );
    if (res.status === 200) {
      const data = (await this.parseJson(res)) as OnnixTicketDetalle;
      return { ok: true, status: 200, data };
    }
    if (res.status === 422) {
      return { ok: false, status: 422, message: await this.extractMessage(res) };
    }
    throw new OnnixUpstreamError(res.status, 'set-estado');
  }

  /**
   * Agrega un comentario a un ticket via `POST /tickets/{code}/comentarios`
   * (#50 R2/R3). Molde exacto de `setEstado`: authedFetch (re-login ante 401),
   * 201/200 → ok, 422 → outcome con message (el dispatcher lo clasifica terminal),
   * resto → OnnixUpstreamError (reintentable).
   *
   * `isInternal` decide la nota interna de OSD (R3.3). El truncado a 10.000 chars
   * lo hace el dispatcher ANTES de llamar (tiene que conservar el prefijo de autor).
   * NUNCA se loggea el `comment`: es contenido de conversacion del cliente.
   *
   * `idempotencyKey` (#51 R2.5/D2.4) viaja como header `Idempotency-Key` y es el id
   * de la outbox-row: estable entre reintentos de la MISMA fila y distinto entre
   * dos filas con el mismo texto, que es exactamente la semantica que hace falta.
   * OSD hoy lo ignora; el dia que lo honre, el duplicado se corta en el servidor y
   * de este lado no hay que escribir una linea mas. Es obligatorio a proposito: si
   * fuera opcional, un caller nuevo podria olvidarlo y perder la garantia en
   * silencio el dia que OSD lo implemente.
   *
   * El body del 2xx se procesa con `extractComentario` (#51 FIX 8/FIX 9): de ahi
   * sale el id que ancla el dedup, y ahi se detecta la nota interna degradada a
   * publica. Ninguno de los dos puede fallar en silencio.
   */
  async addComment(
    code: string,
    comment: string,
    isInternal: boolean,
    traceId: string,
    idempotencyKey: string,
  ): Promise<OnnixCallOutcome<OnnixTicketComentario>> {
    const body: OnnixAddComentarioBody = { comment, is_internal: isInternal };
    const res = await this.authedFetch(
      `/tickets/${encodeURIComponent(code)}/comentarios`,
      'POST',
      body,
      traceId,
      { 'Idempotency-Key': idempotencyKey },
    );
    if (res.status === 201 || res.status === 200) {
      const raw = (await this.parseJson(res)) as OnnixAddComentarioResponse | null;
      const data = this.extractComentario(raw, code, isInternal, traceId, idempotencyKey);
      return { ok: true, status: res.status, data };
    }
    if (res.status === 422) {
      return { ok: false, status: 422, message: await this.extractMessage(res) };
    }
    throw new OnnixUpstreamError(res.status, 'add-comment');
  }

  /**
   * Normaliza el body del 2xx de `POST /tickets/{code}/comentarios` (#51 FIX 8/9).
   * Vive aparte de `addComment` porque hace DOS chequeos de contrato que no pueden
   * quedar sepultados en el camino feliz.
   *
   * FIX 8 — el ancla del dedup puede no existir nunca. El OpenAPI documenta el 201
   * como un `TicketComentario` PELADO, pero el GET del MISMO path devuelve
   * `{ data: [...] }`. Esa asimetria huele a anotacion escrita a mano sobre un
   * `JsonResource` que en realidad envuelve. Si OSD responde `{ data: { id } }` y
   * nosotros solo miramos `body.id`, el id es `undefined` SIEMPRE: ninguna fila
   * COMMENT_ADDED queda anclada y el dedup se queda ciego para siempre. Y su modo de
   * fallo NO es duplicar, es PERDER (ver `getCommentClaimState`). Por eso aceptamos
   * los DOS envoltorios, y si aun asi no hay un id numerico usable dejamos un WARN
   * explicito: el estado degradado se ve en los logs, nunca en silencio.
   *
   * FIX 9 — la nota interna puede publicarse como PUBLICA. El OpenAPI de OSD dice
   * textual que `is_internal=true` requiere el permiso `tickets.internal_note` y que
   * si el usuario NO lo tiene el comentario se guarda como PUBLICO — con 201, no con
   * 403. Tratar ese 201 como exito sin mirar la respuesta significa que cada nota
   * interna del staff ("el cliente no paga hace 3 meses") se publica VISIBLE PARA EL
   * CLIENTE mientras de nuestro lado la fila queda `synced` sin una sola alerta. Es
   * la fuga que el dueño marco como riesgo antes de aprobar #50. Si la respuesta trae
   * `is_internal` y NO coincide con lo pedido, va un ERROR de alta severidad.
   *
   * NO se falla la fila en ninguno de los dos casos: el comentario YA esta en OSD y
   * OSD no tiene delete ni update. Reintentar solo agregaria un duplicado igual de
   * publico. Lo unico util es que un humano se entere.
   *
   * Metadata only en los dos logs (R27): `code`, rowId y traceId. NUNCA el cuerpo del
   * comentario ni la respuesta completa — es conversacion del cliente.
   */
  private extractComentario(
    raw: OnnixAddComentarioResponse | null,
    code: string,
    isInternal: boolean,
    traceId: string,
    rowId: string,
  ): OnnixTicketComentario {
    // Desenvuelve `{ data: {...} }` (Resource de Laravel) o toma el objeto pelado.
    // El `in` distingue sin castear a any y sin romper si `raw` es null.
    const envelope =
      raw !== null && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
    const comentario = (envelope ?? {}) as Partial<OnnixTicketComentario>;

    // El id de Laravel puede llegar como number o como string numerico segun el
    // cast del modelo; normalizamos a number porque el dispatcher lo persiste como
    // externalId y el dedup compara `String(id)`.
    const id = Number(comentario.id);
    const hasId = comentario.id !== undefined && comentario.id !== null && Number.isFinite(id);
    if (!hasId) {
      this.logger.warn(
        `Onnix contrato roto: comentario sin id, la fila queda SIN ancla para el dedup ` +
          `code=${code} rowId=${rowId} traceId=${traceId}`,
      );
    }

    // FIX 9: solo se compara si OSD devolvio el campo. Ausente = no sabemos, y no
    // vamos a gritar por una respuesta simplemente escueta.
    if (typeof comentario.is_internal === 'boolean' && comentario.is_internal !== isInternal) {
      this.logger.error(
        `Onnix FUGA DE VISIBILIDAD: el comentario se guardo con is_internal=` +
          `${comentario.is_internal} y se pidio ${isInternal}. Si se pidio interno y quedo ` +
          `publico, el texto es VISIBLE PARA EL CLIENTE (falta el permiso ` +
          `tickets.internal_note en el usuario de servicio). ` +
          `code=${code} rowId=${rowId} traceId=${traceId}`,
      );
    }

    // Se devuelve el objeto igual (sin id si no vino): la fila SI se sincronizo, solo
    // queda sin ancla. El dispatcher ya contempla `outcome.data?.id === undefined`.
    return { ...comentario, ...(hasId ? { id } : {}) } as OnnixTicketComentario;
  }

  /**
   * Lista los comentarios de un ticket via `GET /tickets/{code}/comentarios`
   * (#51 R2.2/D2.2). Unico consumidor: el chequeo anti-duplicado del dispatcher
   * ANTES de re-postear un comentario cuya suerte quedo ambigua (timeout).
   *
   * Desenvuelve el `{ data: [...] }` de Laravel; si el body no trae `data` (contrato
   * roto o ticket sin comentarios) devuelve `[]` en vez de romper — un dedup que no
   * encuentra nada simplemente postea, que es el comportamiento pre-#51.
   *
   * Cualquier status != 2xx lanza `OnnixUpstreamError` (molde de `getCatalog`), y el
   * dispatcher lo clasifica como transitorio: si NO podemos preguntar "¿ya llego?",
   * NO se postea a ciegas — la fila vuelve a `pending` y se reintenta. Duplicar es
   * peor que esperar un ciclo mas.
   *
   * NUNCA se loggea la respuesta: son los comentarios reales del ticket.
   */
  async listComments(code: string, traceId: string): Promise<OnnixTicketComentario[]> {
    const res = await this.authedFetch(
      `/tickets/${encodeURIComponent(code)}/comentarios`,
      'GET',
      undefined,
      traceId,
    );
    if (!res.ok) throw new OnnixUpstreamError(res.status, 'list-comments');
    const body = (await this.parseJson(res)) as OnnixListComentariosResponse | null;
    const data = Array.isArray(body?.data) ? body.data : [];
    this.warnIfPaginated(body, data.length, code, traceId);
    return data;
  }

  /**
   * Avisa si el GET de comentarios vino PAGINADO (#51 FIX 10).
   *
   * `{ data: [...] }` es exactamente el envoltorio de un `LengthAwarePaginator` de
   * Laravel, y Laravel pagina por default las colecciones grandes. Si OSD pagina,
   * este GET trae SOLO la primera pagina: en un ticket con conversacion larga el
   * dedup compara contra una vista parcial del hilo, no encuentra su POST perdido y
   * re-postea. La direccion del fallo es la buena (duplicar, no perder — R2), asi
   * que NO implementamos la paginacion: no vale la pena traer N paginas de un ticket
   * ruidoso en el camino de reintento. Pero tiene que ser VISIBLE, porque explica
   * duplicados que si no parecerian un bug del dedup.
   *
   * Solo metadata (R27): cantidad y numeros de pagina, nunca los comentarios.
   */
  private warnIfPaginated(
    body: OnnixListComentariosResponse | null,
    received: number,
    code: string,
    traceId: string,
  ): void {
    if (!body) return;
    const lastPage = body.meta?.last_page;
    const total = body.meta?.total;
    const hasMore =
      // `links.next` no-null es la señal mas directa que da Laravel.
      (body.links?.next ?? null) !== null ||
      (typeof lastPage === 'number' && lastPage > 1) ||
      // Red de seguridad si el paginator viene con otra forma: el total declarado no
      // entra en lo que recibimos.
      (typeof total === 'number' && total > received);
    if (!hasMore) return;
    this.logger.warn(
      `Onnix comentarios PAGINADOS: el dedup corrio sobre una pagina parcial ` +
        `(recibidos=${received} total=${total ?? '?'} lastPage=${lastPage ?? '?'}). ` +
        `Un re-post duplicado en este ticket es esperable. code=${code} traceId=${traceId}`,
    );
  }

  /**
   * Miembros de un equipo de OSD (`GET /equipos/{id}/usuarios`) — #52 R4.1.
   * Insumo del seed de mappings de usuario, que matchea por `email` contra
   * `User.email` de Zentik (unico). NO filtra `is_active` aca: el filtro es del
   * seed (R1.2), y el cliente devuelve lo que OSD dijo, tal cual.
   *
   * Acepta el array pelado Y el `{ data: [...] }` de Laravel (#51 FIX 8): dentro del
   * mismo OpenAPI de OSD conviven las dos formas, y adivinar mal aca no rompe nada
   * ruidosamente — simplemente mapea CERO usuarios y manda a todo el equipo al
   * skip+warn de R3.3. Un modo de fallo silencioso no se puede aceptar en el camino
   * que decide si el responsable viaja o no.
   *
   * Cualquier status != 2xx lanza `OnnixUpstreamError` (molde de `getCatalog`): el
   * seed es un endpoint admin manual, y un error visible es mejor que un reporte
   * con ceros que el dueño interprete como "no hay nadie en el equipo".
   */
  async getTeamMembers(
    teamId: number,
    traceId: string,
  ): Promise<OnnixEquipoUsuario[]> {
    const res = await this.authedFetch(
      `/equipos/${encodeURIComponent(String(teamId))}/usuarios`,
      'GET',
      undefined,
      traceId,
    );
    if (!res.ok) throw new OnnixUpstreamError(res.status, 'team-members');
    const body = (await this.parseJson(
      res,
    )) as OnnixListEquipoUsuariosResponse | null;
    if (Array.isArray(body)) return body;
    return Array.isArray(body?.data) ? body.data : [];
  }

  /**
   * Asigna el responsable de un ticket via `POST /tickets/{code}/asignar` — #52 R4.2.
   * Molde exacto de `setEstado`: authedFetch (re-login ante 401), 200/201 → ok,
   * 422 → outcome con message, resto → OnnixUpstreamError (reintentable).
   *
   * ⚠️ EL 422 DE ESTE ENDPOINT NO ES TERMINAL PARA EL DISPATCHER (#52 R3.3), a
   * diferencia de todos los demas. OSD devuelve 422 cuando el cerco del rol
   * `integracion` rechaza al destinatario ("no es de tu equipo" / "otro producto"):
   * es un limite CONOCIDO de permisos, no un defecto nuestro, y mandarlo a la DLQ
   * llenaria la cola de filas que ningun requeue va a poder arreglar. La
   * clasificacion vive en `processAssign`, no aca: el cliente solo reporta.
   *
   * El `reason` viaja tal cual (ya truncado a ASSIGN_REASON_MAX_LEN por el
   * dispatcher, que es quien sabe armarlo con el nombre del actor).
   */
  async assignTicket(
    code: string,
    body: OnnixAsignarBody,
    traceId: string,
  ): Promise<OnnixCallOutcome<OnnixTicketDetalle>> {
    const res = await this.authedFetch(
      `/tickets/${encodeURIComponent(code)}/asignar`,
      'POST',
      body,
      traceId,
    );
    if (res.status === 200 || res.status === 201) {
      const data = (await this.parseJson(res)) as OnnixTicketDetalle;
      return { ok: true, status: res.status, data };
    }
    if (res.status === 422) {
      return { ok: false, status: 422, message: await this.extractMessage(res) };
    }
    throw new OnnixUpstreamError(res.status, 'assign-ticket');
  }

  /** Trae los 4 catalogos para el mapeo (R19). El mapping los cachea (R20). */
  async getCatalogos(traceId: string): Promise<OnnixCatalogos> {
    const [estados, tipos, categorias, prioridades] = await Promise.all([
      this.getCatalog<OnnixEstado>('/catalogos/estados', traceId),
      this.getCatalog<OnnixCatalogItem>('/catalogos/tipos', traceId),
      this.getCatalog<OnnixCatalogItem>('/catalogos/categorias', traceId),
      this.getCatalog<OnnixCatalogItem>('/catalogos/prioridades', traceId),
    ]);
    return { estados, tipos, categorias, prioridades };
  }

  private async getCatalog<T>(path: string, traceId: string): Promise<T[]> {
    const res = await this.authedFetch(path, 'GET', undefined, traceId);
    if (!res.ok) throw new OnnixUpstreamError(res.status, `catalog:${path}`);
    return (await this.parseJson(res)) as T[];
  }

  // ── Capa HTTP ─────────────────────────────────────────────────────────────

  /**
   * Hace una llamada autenticada con re-login automatico ante 401 (R26): el
   * primer 401 invalida el token, re-loguea y reintenta UNA vez la MISMA llamada
   * SIN contar el intento como fallo de negocio (el caller no incrementa attempts).
   * Un segundo 401 = error de auth real → OnnixUpstreamError(401).
   *
   * `extraHeaders` (#51 D2.4) permite headers propios de una operacion —hoy solo
   * `Idempotency-Key`— sin que cada llamada tenga que rearmar la capa HTTP. Viaja
   * TAMBIEN en el reintento post-relogin: es la misma operacion de negocio, asi que
   * tiene que llevar la misma clave de idempotencia.
   */
  private async authedFetch(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    traceId: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const baseUrl = this.requireSecret('ONNIX_BASE_URL', this.config.onnixBaseUrl);
    const url = `${baseUrl}${path}`;

    let token = await this.getToken();
    let res = await this.rawFetch(url, method, body, token, traceId, extraHeaders);

    if (res.status === 401) {
      // Token expirado → re-login 1 vez (NO cuenta como intento de negocio).
      await this.invalidateToken();
      token = await this.login();
      res = await this.rawFetch(url, method, body, token, traceId, extraHeaders);
      if (res.status === 401) {
        // 2do 401 = credenciales invalidas reales → error de auth (alerta).
        this.logger.error(`Onnix auth persistente 401 path=${path} traceId=${traceId}`);
        throw new OnnixUpstreamError(401, 'auth');
      }
    }
    return res;
  }

  /**
   * fetch nativo + AbortController + timeout por env. Molde mcp-client:145-184.
   * Propaga X-Trace-Id para logging correlacionado (R43). AbortError → 504,
   * otro error de red → 502. NUNCA loggea body ni token.
   */
  private async rawFetch(
    url: string,
    method: 'GET' | 'POST',
    body: unknown,
    token: string | undefined,
    traceId?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.onnixHttpTimeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(traceId ? { 'X-Trace-Id': traceId } : {}),
          // Headers propios de la operacion (hoy solo Idempotency-Key, #51 D2.4).
          // Van al final para que un header de negocio nunca quede tapado por los
          // de transporte; ninguna key colisiona con las de arriba.
          ...(extraHeaders ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      const isAbort = (err as { name?: string } | null)?.name === 'AbortError';
      // Metadata only: ni url completa con query secrets ni body.
      this.logger.warn(
        `Onnix transport error method=${method} abort=${isAbort} traceId=${traceId ?? '-'}`,
      );
      throw new OnnixUpstreamError(isAbort ? 504 : 502, isAbort ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new OnnixUpstreamError(502, 'json-malformed');
    }
  }

  /**
   * Extrae el `message` de un 422 Onnix sin loggear payloads. Onnix devuelve
   * `{ message, errors }` en 422.
   */
  private async extractMessage(res: Response): Promise<string> {
    try {
      const body = (await this.parseJson(res)) as { message?: string } | null;
      return body?.message ?? '';
    } catch {
      return '';
    }
  }
}
