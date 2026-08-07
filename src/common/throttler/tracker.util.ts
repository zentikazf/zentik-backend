import { createHash } from 'crypto';

/**
 * Trackers del rate-limit (#45).
 *
 * Fuente ÚNICA de la identidad que el ThrottlerGuard usa para armar el bucket,
 * reusada por el contador de duplicados (`DuplicateRequestMiddleware`) para que
 * ambos midan al MISMO sujeto.
 *
 * ⚠️ El `ThrottlerGuard` corre ANTES del `AuthGuard` (es APP_GUARD controller-level):
 * `req.user` todavía NO existe. Por eso el tracker de sesión lee el token CRUDO
 * (Bearer o cookie) y lo hashea — nunca `req.user`.
 */

/**
 * Nombres reales de la cookie de sesión. Espejo EXACTO —y en el mismo orden— de
 * `AuthController.extractSessionToken`. Si esta lista se desincroniza del auth,
 * el tracker cae al fallback por IP y el aislamiento por usuario deja de existir
 * (ver Riesgos del design.md). Mantener en sync es un contrato duro.
 */
const SESSION_COOKIE_NAMES = [
  '__Host-zentik.session_token', // prod same-site (COOKIE_SAMESITE_LAX=true)
  'zentik.session_token', // dev / cross-site (default)
  'better-auth.session_token', // legacy
  '__Secure-better-auth.session_token', // legacy
];

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Token de sesión crudo desde el Bearer header o cualquiera de las cookies. */
function rawSessionToken(req: Record<string, any>): string | undefined {
  const auth = req?.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  // `cookieParser` es middleware y corre antes que los guards → req.cookies poblado.
  const cookies = req?.cookies ?? {};
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return cookies[name];
  }
  return undefined;
}

/**
 * Tracker de rutas autenticadas: por SESIÓN (token hasheado). Sin sesión cae a
 * la IP (que ahora es la real del cliente gracias a `trust proxy`, T1). El hash
 * es obligatorio: el tracker viaja al `ThrottlerLimitDetail` y puede terminar en
 * logs/Sentry — nunca el token en claro.
 */
export function sessionTracker(req: Record<string, any>): string {
  const raw = rawSessionToken(req);
  return raw ? `s:${hash(raw)}` : `ip:${req?.ip ?? 'unknown'}`;
}

/**
 * Tracker de login/registro por EMAIL del body (hasheado). Protege la cuenta
 * puntual del brute force. En login/registro todavía NO hay sesión — por eso NO
 * se puede usar `sessionTracker` acá (caería a IP y castigaría a toda la oficina
 * detrás de un NAT). El body ya está parseado cuando corre el guard.
 */
export function authEmailTracker(req: Record<string, any>): string {
  const email = typeof req?.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `authmail:${email ? hash(email) : 'anon'}`;
}

/**
 * Tracker de login/registro por IP. Backstop AMPLIO (NAT-safe): una oficina sale
 * por UNA IP pública, así que este límite es mucho más generoso que el de email
 * — frena a un atacante que rota emails desde una IP, sin bloquear al equipo.
 */
export function authIpTracker(req: Record<string, any>): string {
  return `authip:${req?.ip ?? 'unknown'}`;
}
