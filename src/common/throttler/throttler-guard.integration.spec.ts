import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import { buildThrottlerOptions } from './throttler.config';

/**
 * Integración del ThrottlerGuard REAL con la config de #45 (T2/T3/T4).
 *
 * Monta el guard de @nestjs/throttler v6.5.0 con storage en memoria y maneja
 * ExecutionContexts falsos → valida el cableado end-to-end (skipIf de rutas +
 * getTracker por throttler + límites), no solo el shape de la config.
 */
class AuthController {}
function login() {}
class TicketController {}
function getTicket() {}

const makeCtx = (req: any, handler: () => void, cls: new () => unknown) => {
  const res = { header: jest.fn() };
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
};

const loginReq = (email: string, ip = '10.0.0.1') => ({
  path: '/api/v1/auth/login',
  method: 'POST',
  headers: {},
  cookies: {},
  ip,
  body: { email },
});

const getReq = (id: string, session: string, ip = '10.0.0.1') => ({
  path: `/api/v1/tickets/${id}`,
  method: 'GET',
  headers: { authorization: `Bearer ${session}` },
  cookies: {},
  ip,
  body: {},
});

describe('ThrottlerGuard + config #45 (integración)', () => {
  let guard: ThrottlerGuard;
  let storage: ThrottlerStorageService;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new ThrottlerGuard(buildThrottlerOptions(), storage, new Reflector());
    await guard.onModuleInit();
  });

  afterEach(() => storage.onApplicationShutdown());

  it('T3: 6 logins de emails DISTINTOS desde la misma IP → todos pasan (hoy el 6º falla)', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(
        guard.canActivate(makeCtx(loginReq(`u${i}@x.com`), login, AuthController)),
      ).resolves.toBe(true);
    }
  });

  it('T3: el MISMO email 6 veces → el 6º se bloquea (brute force por cuenta)', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        guard.canActivate(makeCtx(loginReq('a@x.com'), login, AuthController)),
      ).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(makeCtx(loginReq('a@x.com'), login, AuthController)),
    ).rejects.toThrow();
  });

  it('T4: 10 GETs seguidos al mismo endpoint de lectura → 200', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        guard.canActivate(makeCtx(getReq('abc', 'sess-1'), getTicket, TicketController)),
      ).resolves.toBe(true);
    }
  });

  it('T4: ráfaga absurda al mismo endpoint → 429', async () => {
    await expect(async () => {
      for (let i = 0; i < 40; i++) {
        await guard.canActivate(makeCtx(getReq('abc', 'sess-1'), getTicket, TicketController));
      }
    }).rejects.toThrow();
  });

  it('T2: dos sesiones distintas NO comparten bucket (misma ruta)', async () => {
    // Sesión 1 agota su `short` (30/seg) hasta bloquear.
    await expect(async () => {
      for (let i = 0; i < 40; i++) {
        await guard.canActivate(makeCtx(getReq('abc', 'sess-1'), getTicket, TicketController));
      }
    }).rejects.toThrow();
    // Sesión 2, sobre el MISMO endpoint, arranca con su bucket limpio.
    await expect(
      guard.canActivate(makeCtx(getReq('abc', 'sess-2'), getTicket, TicketController)),
    ).resolves.toBe(true);
  });
});
