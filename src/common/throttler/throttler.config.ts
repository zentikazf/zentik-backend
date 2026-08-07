import { ExecutionContext } from '@nestjs/common';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { sessionTracker, authEmailTracker, authIpTracker } from './tracker.util';

/**
 * Config del rate-limit (#45). Extraída de app.module para poder testearla como
 * unidad (skipIf de rutas + shape de tiers). Ver design.md D2/D3.
 */

/**
 * Rutas de auth SIN sesión (login/registro): se trackean por email+IP, no por
 * sesión. Se matchea por sufijo del path (robusto al global prefix `/api/v1`).
 *
 * reset/forgot/update-password NO entran acá: reset no trae `email` en el body
 * (keyearía todo bajo `authmail:anon` = un cupo global) y update-password ya
 * tiene sesión. Esos conservan su `@Throttle` sobre el tier `short`.
 */
export function isAuthEmailPath(ctx: ExecutionContext): boolean {
  if (ctx.getType() !== 'http') return false;
  const req = ctx.switchToHttp().getRequest();
  const path: string = (req?.path || req?.url || '').split('?')[0];
  return path.endsWith('/auth/login') || path.endsWith('/auth/register');
}

/**
 * Opciones del `ThrottlerModule` en forma OBJETO (la forma array no admite
 * `getTracker` común).
 *
 * Tiers `short`/`medium`/`long`: se mantienen los NOMBRES a propósito — admin-mcp
 * (per-min + per-día), onboarding y client los overridean por ruta con
 * `@Throttle({ short/long })`; renombrarlos volvería esos overrides no-op y
 * aflojaría esos endpoints en silencio. Solo se recalibran los LÍMITES base: el
 * 3/seg viejo era per-endpoint para TODA la empresa (bucket colapsado por IP
 * interna de Railway); ninguna lectura del dashboard vive en 3/seg (R3.1).
 *
 * Los tres tiers son per-endpoint (generateKey default incluye handler+clase). No
 * se agrega un tier cross-endpoint extra: el runaway reportado es siempre al MISMO
 * endpoint (lo corta `short`), y un techo cross-endpoint reintroduce el riesgo de
 * 429 falsos contra "colegas, no abuso" — justo el bug que se arregla.
 *
 * Storage (T6/D5): memoria del proceso (default). Con varias réplicas el límite
 * sería por réplica y se resetea en cada deploy; el `Map` interno tampoco purga.
 * DIFERIDO: hoy es single-replica en Railway y no hay adapter Redis instalado.
 * Para activarlo al escalar: instalar `@nest-lab/throttler-storage-redis` y pasar
 * `storage: new ThrottlerStorageRedisService(REDIS_URL)` acá. El contador de
 * duplicados (D4) comparte el mismo tradeoff.
 */
export function buildThrottlerOptions(): ThrottlerModuleOptions {
  return {
    throttlers: [
      // Sesión (rutas autenticadas). `skipIf` los salta en login/registro, que
      // van por los throttlers de auth de abajo (ahí todavía no hay sesión).
      { name: 'short', ttl: 1000, limit: 30, skipIf: isAuthEmailPath },
      { name: 'medium', ttl: 10000, limit: 200, skipIf: isAuthEmailPath },
      { name: 'long', ttl: 60000, limit: 600, skipIf: isAuthEmailPath },
      // Login/registro: estricto por EMAIL (protege la cuenta del brute force) +
      // amplio por IP (NAT-safe: la oficina entera sale por una IP pública — el
      // bug que hoy hace fallar el sexto login de la mañana). Solo esas rutas.
      {
        name: 'auth-email',
        ttl: 60000,
        limit: 5,
        getTracker: authEmailTracker,
        skipIf: (ctx) => !isAuthEmailPath(ctx),
      },
      {
        name: 'auth-ip',
        ttl: 60000,
        limit: 50,
        getTracker: authIpTracker,
        skipIf: (ctx) => !isAuthEmailPath(ctx),
      },
    ],
    // Tracker común de los tiers de sesión (short/medium/long). Los de auth traen
    // el suyo propio.
    getTracker: sessionTracker,
  };
}
