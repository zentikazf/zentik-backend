import { sessionTracker, authEmailTracker, authIpTracker } from './tracker.util';

/**
 * Tests de los trackers del rate-limit (#45 T2/T3).
 *
 * Son la identidad con la que el ThrottlerGuard arma el bucket. Lo crítico:
 * dos sesiones distintas → trackers distintos (aislamiento por usuario), el
 * token/email nunca viajan en claro (van hasheados), y login keyea por email
 * (no por IP colapsada de NAT).
 */
const reqWith = (over: Record<string, any> = {}): Record<string, any> => ({
  headers: {},
  cookies: {},
  ip: '1.2.3.4',
  body: {},
  ...over,
});

describe('sessionTracker (#45 T2)', () => {
  it('Bearer → s:<sha256 truncado>, determinista', () => {
    const t = sessionTracker(reqWith({ headers: { authorization: 'Bearer tok-abc' } }));
    expect(t).toMatch(/^s:[0-9a-f]{32}$/);
    expect(sessionTracker(reqWith({ headers: { authorization: 'Bearer tok-abc' } }))).toBe(t);
  });

  it('cookie de sesión plana → s:<hash>', () => {
    expect(sessionTracker(reqWith({ cookies: { 'zentik.session_token': 'ck-1' } }))).toMatch(
      /^s:[0-9a-f]{32}$/,
    );
  });

  it('la cookie __Host- tiene prioridad sobre la plana (espeja extractSessionToken)', () => {
    const both = sessionTracker(
      reqWith({ cookies: { '__Host-zentik.session_token': 'A', 'zentik.session_token': 'B' } }),
    );
    const hostOnly = sessionTracker(reqWith({ cookies: { '__Host-zentik.session_token': 'A' } }));
    expect(both).toBe(hostOnly);
  });

  it('el Bearer tiene prioridad sobre la cookie', () => {
    const t = sessionTracker(
      reqWith({ headers: { authorization: 'Bearer X' }, cookies: { 'zentik.session_token': 'Y' } }),
    );
    expect(t).toBe(sessionTracker(reqWith({ headers: { authorization: 'Bearer X' } })));
  });

  it('anónimo (sin token) → ip:<req.ip>', () => {
    expect(sessionTracker(reqWith({ ip: '9.9.9.9' }))).toBe('ip:9.9.9.9');
  });

  it('dos sesiones distintas NO comparten tracker', () => {
    const a = sessionTracker(reqWith({ headers: { authorization: 'Bearer AAA' } }));
    const b = sessionTracker(reqWith({ headers: { authorization: 'Bearer BBB' } }));
    expect(a).not.toBe(b);
  });

  it('nunca expone el token en claro (va hasheado)', () => {
    const t = sessionTracker(reqWith({ headers: { authorization: 'Bearer super-secret-token' } }));
    expect(t).not.toContain('super-secret-token');
  });

  it('req.ip ausente → ip:unknown (no rompe)', () => {
    expect(sessionTracker({ headers: {}, cookies: {} })).toBe('ip:unknown');
  });
});

describe('authEmailTracker (#45 T3)', () => {
  it('normaliza case + espacios (mismo email → mismo bucket)', () => {
    const a = authEmailTracker(reqWith({ body: { email: '  User@Mail.com ' } }));
    const b = authEmailTracker(reqWith({ body: { email: 'user@mail.com' } }));
    expect(a).toBe(b);
  });

  it('6 emails distintos → 6 trackers distintos (los 6 logins pasan)', () => {
    const set = new Set(
      Array.from({ length: 6 }, (_, i) => authEmailTracker(reqWith({ body: { email: `u${i}@x.com` } }))),
    );
    expect(set.size).toBe(6);
  });

  it('sin email en el body → authmail:anon', () => {
    expect(authEmailTracker(reqWith())).toBe('authmail:anon');
  });

  it('no expone el email en claro', () => {
    expect(authEmailTracker(reqWith({ body: { email: 'secret@x.com' } }))).not.toContain('secret');
  });
});

describe('authIpTracker (#45 T3)', () => {
  it('misma IP con emails distintos → MISMO authip (backstop NAT amplio)', () => {
    const a = authIpTracker(reqWith({ ip: '5.5.5.5', body: { email: 'a@x.com' } }));
    const b = authIpTracker(reqWith({ ip: '5.5.5.5', body: { email: 'b@x.com' } }));
    expect(a).toBe('authip:5.5.5.5');
    expect(a).toBe(b);
  });
});
