import { ExecutionContext } from '@nestjs/common';
import { isAuthEmailPath, buildThrottlerOptions, TRUST_PROXY_HOPS } from './throttler.config';

/**
 * Tests de la config del throttler (#45). `isAuthEmailPath` decide qué tiers
 * aplican en cada ruta; equivocarlo rompería el aislamiento (login cayendo en el
 * bucket de sesión, o rutas normales keyeadas por email/anon).
 */
const ctxOf = (path: string, type: 'http' | 'ws' = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ path }) }),
  }) as unknown as ExecutionContext;

describe('TRUST_PROXY_HOPS (#46 R2)', () => {
  it('vale 2: el hop count verificado contra Railway (con 1, `req.ip` se quedaba en el edge)', () => {
    expect(TRUST_PROXY_HOPS).toBe(2);
  });

  it('es un entero, nunca `true` (con `true` el XFF que escribe el cliente es falsificable)', () => {
    expect(typeof TRUST_PROXY_HOPS).toBe('number');
    expect(Number.isInteger(TRUST_PROXY_HOPS)).toBe(true);
  });

  it('ninguna env lo pisa: es constante, no configuración', () => {
    const prev = process.env.TRUST_PROXY_HOPS;
    process.env.TRUST_PROXY_HOPS = '9';
    try {
      let fresh: number | undefined;
      jest.isolateModules(() => {
        fresh = (require('./throttler.config') as typeof import('./throttler.config')).TRUST_PROXY_HOPS;
      });
      expect(fresh).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = prev;
    }
  });
});

describe('isAuthEmailPath (#45 T3)', () => {
  it.each(['/api/v1/auth/login', '/api/v1/auth/register', '/auth/login', '/auth/register'])(
    'matchea %s',
    (p) => {
      expect(isAuthEmailPath(ctxOf(p))).toBe(true);
    },
  );

  it.each([
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/auth/update-password',
    '/api/v1/tickets/abc',
    '/api/v1/auth/me',
  ])('NO matchea %s', (p) => {
    expect(isAuthEmailPath(ctxOf(p))).toBe(false);
  });

  it('ignora la query string', () => {
    expect(isAuthEmailPath(ctxOf('/api/v1/auth/login?redirect=/x'))).toBe(true);
  });

  it('contexto no-http (ws) → false', () => {
    expect(isAuthEmailPath(ctxOf('/auth/login', 'ws'))).toBe(false);
  });
});

describe('buildThrottlerOptions (#45 T2/T3/T4)', () => {
  const opts = buildThrottlerOptions() as any;
  const tier = (name: string) => opts.throttlers.find((t: any) => t.name === name);

  it('forma OBJETO con getTracker común de sesión', () => {
    expect(typeof opts.getTracker).toBe('function');
    expect(Array.isArray(opts.throttlers)).toBe(true);
  });

  it('tiers de sesión recalibrados (short 30/1s, medium 200/10s, long 600/60s)', () => {
    expect(tier('short')).toMatchObject({ ttl: 1000, limit: 30 });
    expect(tier('medium')).toMatchObject({ ttl: 10000, limit: 200 });
    expect(tier('long')).toMatchObject({ ttl: 60000, limit: 600 });
  });

  it('los tiers de sesión se SALTAN en login/registro (van por auth-email/ip)', () => {
    for (const name of ['short', 'medium', 'long']) {
      expect(tier(name).skipIf(ctxOf('/auth/login'))).toBe(true);
      expect(tier(name).skipIf(ctxOf('/api/v1/tickets/x'))).toBe(false);
    }
  });

  it('auth-email: estricto (5/60s), tracker propio, SOLO en login/registro', () => {
    const ae = tier('auth-email');
    expect(ae).toMatchObject({ ttl: 60000, limit: 5 });
    expect(typeof ae.getTracker).toBe('function');
    expect(ae.skipIf(ctxOf('/api/v1/tickets/x'))).toBe(true); // se salta fuera de auth
    expect(ae.skipIf(ctxOf('/auth/login'))).toBe(false);
  });

  it('auth-ip: amplio NAT-safe (50/60s), SOLO en login/registro', () => {
    const ai = tier('auth-ip');
    expect(ai).toMatchObject({ ttl: 60000, limit: 50 });
    expect(ai.skipIf(ctxOf('/auth/register'))).toBe(false);
    expect(ai.skipIf(ctxOf('/api/v1/auth/me'))).toBe(true);
  });
});
