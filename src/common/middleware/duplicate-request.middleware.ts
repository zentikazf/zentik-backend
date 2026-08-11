import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { sessionTracker } from '../throttler/tracker.util';

/**
 * Umbral y ventana del contador (#46 R3). Constantes, no env: son el punto de
 * disparo de una alarma de diagnóstico que nadie tunea por entorno (nunca
 * estuvieron seteadas en Railway — siempre corrieron con estos valores).
 */
const DUP_REQUEST_WARN_THRESHOLD = 3;
const DUP_REQUEST_WINDOW_MS = 1000;

/**
 * Contador de requests duplicados (#45 D4) — reemplazo de la alarma que era el 429.
 *
 * Al arreglar el throttler, las N llamadas al mismo endpoint por render dejan de
 * doler pero SIGUEN pasando → quedaríamos ciegos al feedback loop que las genera.
 * Este middleware las cuenta por `(sesión, método, ruta)` en una ventana corta y
 * loguea UN `warn` al cruzar el umbral, con `correlationId` + ruta + conteo.
 *
 * - Es diagnóstico: NO bloquea nada.
 * - Es el definition-of-done medible de la tanda 04 (comparar antes/después de la
 *   vista de ticket). Si TSQ no baja este número, no sirvió.
 * - Storage: `Map` en memoria del proceso con purga por TTL (mismo tradeoff que el
 *   throttler — ver nota de storage en throttler.config.ts).
 *
 * Queda como alarma permanente (#46 R3.2): cuesta nada y avisa si la duplicación
 * vuelve. La causa de la tanda 04 (`reactStrictMode` en dev) se arregló de raíz.
 */
@Injectable()
export class DuplicateRequestMiddleware implements NestMiddleware {
  private readonly logger = new Logger(DuplicateRequestMiddleware.name);
  // key = `${tracker}|${method}|${path}` → timestamps (ms) dentro de la ventana.
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  use(req: Request, res: Response, next: NextFunction): void {
    const path = (req.originalUrl || req.url || '').split('?')[0];

    // Health/readiness se sondean sin parar: contarlas sería ruido puro.
    if (path.includes('/health')) {
      next();
      return;
    }

    const windowMs = DUP_REQUEST_WINDOW_MS;
    const threshold = DUP_REQUEST_WARN_THRESHOLD;
    const now = Date.now();

    const tracker = sessionTracker(req as unknown as Record<string, any>);
    const key = `${tracker}|${req.method}|${path}`;

    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.hits.set(key, recent);

    // Un solo warn por ventana/clave: se dispara EXACTAMENTE al cruzar el umbral.
    if (recent.length === threshold + 1) {
      const correlationId = (req as any).correlationId ?? req.headers['x-correlation-id'];
      this.logger.warn(
        `Requests duplicados: ${recent.length} × ${req.method} ${path} en ${windowMs}ms ` +
          `[tracker=${tracker} correlationId=${correlationId ?? 'n/a'}]`,
      );
    }

    this.sweep(now, windowMs);
    next();
  }

  /** Purga perezosa (a lo sumo 1×/ventana) de claves sin hits vigentes. */
  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    for (const [key, timestamps] of this.hits) {
      const alive = timestamps.filter((t) => now - t < windowMs);
      if (alive.length === 0) this.hits.delete(key);
      else this.hits.set(key, alive);
    }
  }
}
