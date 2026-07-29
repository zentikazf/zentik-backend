import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import { BotmakerConsumptionsResponse } from './types/botmaker.types';

/**
 * Cliente HTTP de Botmaker (feature #23) — SOLO camino admin.
 *
 * Molde: `sync/onnix-client.service.ts` (fetch nativo + AbortController + timeout por env, sin axios).
 * Seguridad: el `access-token` va SOLO en el header, NUNCA se loggea (metadata-only en errores). El caller
 * ya verificó el flag `BOTMAKER_BILLING_ENABLED`; acá se valida en runtime que el secreto exista.
 */
@Injectable()
export class BotmakerClientService {
  private readonly logger = new Logger(BotmakerClientService.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * GET {BASE}/v2.0/billing/consumptions?billing-period=YYYY-MM con header `access-token`. Devuelve el
   * payload crudo (el normalizador lo endurece). AbortError → 504, otro error de red → 502; !ok → 502.
   */
  async fetchConsumptions(period: string): Promise<BotmakerConsumptionsResponse> {
    const baseUrl = this.requireSecret('BOTMAKER_BASE_URL', this.config.botmakerBaseUrl);
    const token = this.requireSecret('BOTMAKER_ACCESS_TOKEN', this.config.botmakerAccessToken);

    const url = `${baseUrl.replace(/\/$/, '')}/v2.0/billing/consumptions?billing-period=${encodeURIComponent(period)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.botmakerHttpTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'access-token': token },
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = (err as { name?: string } | null)?.name === 'AbortError';
      // Metadata-only: el token va en headers, NO en el mensaje de red. `period`/URL no son sensibles.
      // Se incluye name/message + cause.code (undici envuelve DNS/TLS/URL-inválida ahí) para diagnosticar.
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const causeStr = cause?.code || cause?.message ? ` cause=${cause.code ?? cause.message}` : '';
      this.logger.warn(`Botmaker transport error period=${period} abort=${isAbort} — ${detail}${causeStr}`);
      throw new AppException(
        isAbort ? 'Botmaker no respondió a tiempo' : 'No se pudo contactar a Botmaker',
        isAbort ? 'BOTMAKER_TIMEOUT' : 'BOTMAKER_UNREACHABLE',
        isAbort ? 504 : 502,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Nunca loggear el body (puede reflejar datos de facturación). Solo el status.
      this.logger.error(`Botmaker consumptions fallo status=${res.status} period=${period}`);
      throw new AppException('Botmaker devolvió un error', 'BOTMAKER_UPSTREAM_ERROR', 502, {
        status: res.status,
      });
    }

    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as BotmakerConsumptionsResponse;
    } catch {
      throw new AppException('Botmaker devolvió una respuesta inválida', 'BOTMAKER_BAD_RESPONSE', 502);
    }
  }

  private requireSecret(name: string, value: string | undefined): string {
    if (!value) {
      // El flag esta on pero falta el secreto: error de runtime, NUNCA del boot.
      throw new AppException(
        `Falta configurar ${name} para usar la facturación de Botmaker`,
        'BOTMAKER_NOT_CONFIGURED',
        503,
        { missing: name },
      );
    }
    return value;
  }
}
