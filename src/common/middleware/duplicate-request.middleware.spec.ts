import { Logger } from '@nestjs/common';
import { DuplicateRequestMiddleware } from './duplicate-request.middleware';

/**
 * Tests del contador de duplicados (#45 D4/T5). Reemplaza la alarma que era el
 * 429: cuenta por (sesión, método, ruta) y loguea UN warn al cruzar el umbral.
 */
describe('DuplicateRequestMiddleware (#45 D4)', () => {
  const config = { dupRequestWindowMs: 1000, dupRequestWarnThreshold: 3 } as any;
  let warnSpy: jest.SpyInstance;

  const mw = () => new DuplicateRequestMiddleware(config);
  const reqOf = (over: Record<string, any> = {}) => ({
    method: 'GET',
    originalUrl: '/api/v1/tickets/abc',
    headers: {},
    cookies: {},
    ip: '1.1.1.1',
    ...over,
  });
  const hit = (m: DuplicateRequestMiddleware, req: any, n = 1) => {
    for (let i = 0; i < n; i++) {
      const next = jest.fn();
      m.use(req as any, {} as any, next as any);
      expect(next).toHaveBeenCalledTimes(1);
    }
  };

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it('un solo warn EXACTO al cruzar el umbral (4ª request con umbral 3), con el conteo', () => {
    const m = mw();
    const req = reqOf();
    hit(m, req, 3);
    expect(warnSpy).not.toHaveBeenCalled();
    hit(m, req, 1); // la 4ª cruza el umbral
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('4 × GET /api/v1/tickets/abc');
  });

  it('no re-loguea después del primer cruce dentro de la ventana', () => {
    const m = mw();
    hit(m, reqOf(), 8);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('cuenta por RUTA: dos endpoints distintos no se suman', () => {
    const m = mw();
    hit(m, reqOf({ originalUrl: '/api/v1/tickets/A' }), 3);
    hit(m, reqOf({ originalUrl: '/api/v1/tickets/B' }), 3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('cuenta por SESIÓN: dos sesiones distintas no se suman', () => {
    const m = mw();
    hit(m, reqOf({ headers: { authorization: 'Bearer A' } }), 3);
    hit(m, reqOf({ headers: { authorization: 'Bearer B' } }), 3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('requests fuera de la ventana no acumulan', () => {
    const m = mw();
    const req = reqOf();
    let now = 1_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    hit(m, req, 3); // t=1000 → 3 hits
    now = 3_000; // > windowMs después → los viejos expiran
    hit(m, req, 3); // vuelve a arrancar en 3
    expect(warnSpy).not.toHaveBeenCalled();
    dateSpy.mockRestore();
  });

  it('salta /health (no cuenta los probes)', () => {
    const m = mw();
    hit(m, reqOf({ originalUrl: '/health' }), 10);
    hit(m, reqOf({ originalUrl: '/health/ready' }), 10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('el warn incluye el correlationId', () => {
    const m = mw();
    hit(m, reqOf({ correlationId: 'req-xyz' }), 4);
    expect(String(warnSpy.mock.calls[0][0])).toContain('req-xyz');
  });
});
