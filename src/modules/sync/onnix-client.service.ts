import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixConfigError, OnnixUpstreamError } from './errors';
import {
  OnnixAddComentarioBody,
  OnnixCallOutcome,
  OnnixCatalogItem,
  OnnixCatalogos,
  OnnixCreateTicketBody,
  OnnixEstado,
  OnnixLoginResponse,
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
   */
  async addComment(
    code: string,
    comment: string,
    isInternal: boolean,
    traceId: string,
  ): Promise<OnnixCallOutcome<OnnixTicketComentario>> {
    const body: OnnixAddComentarioBody = { comment, is_internal: isInternal };
    const res = await this.authedFetch(
      `/tickets/${encodeURIComponent(code)}/comentarios`,
      'POST',
      body,
      traceId,
    );
    if (res.status === 201 || res.status === 200) {
      const data = (await this.parseJson(res)) as OnnixTicketComentario;
      return { ok: true, status: res.status, data };
    }
    if (res.status === 422) {
      return { ok: false, status: 422, message: await this.extractMessage(res) };
    }
    throw new OnnixUpstreamError(res.status, 'add-comment');
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
   */
  private async authedFetch(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    traceId: string,
  ): Promise<Response> {
    const baseUrl = this.requireSecret('ONNIX_BASE_URL', this.config.onnixBaseUrl);
    const url = `${baseUrl}${path}`;

    let token = await this.getToken();
    let res = await this.rawFetch(url, method, body, token, traceId);

    if (res.status === 401) {
      // Token expirado → re-login 1 vez (NO cuenta como intento de negocio).
      await this.invalidateToken();
      token = await this.login();
      res = await this.rawFetch(url, method, body, token, traceId);
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
