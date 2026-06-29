/**
 * Helper de redaccion de PII en strings sueltos. Copia local del helper
 * homonimo del MCP (no se comparte via npm para evitar acoplamiento
 * cross-proyecto). Feature #15 — Capa 5.
 *
 * Las 3 regex cubren los casos detectados en la auditoria wn6g3c6du:
 *  - emails: `[\w.+-]+@[\w-]+\.[\w.-]+` -> `[email]`
 *  - Bearer tokens: `Bearer <token>` -> `Bearer [token]`
 *  - secuencias hex largas (>=32 chars): session tokens, sha256, etc. -> `[hex]`
 *
 * NO intenta detectar todo (defense-in-depth, no silver bullet). El call
 * principal es bodyPreview del introspect y campos `where` del LLM antes
 * de loggear. Nunca debe usarse para "limpiar" outputs que el usuario VE
 * en el frontend — usar sanitize-args.ts para eso.
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9_\-.]+/gi;
const HEX_RE = /[a-f0-9]{32,}/gi;

export function redactPII(s: string): string {
  if (typeof s !== 'string') return s;
  return s
    .replace(EMAIL_RE, '[email]')
    .replace(BEARER_RE, 'Bearer [token]')
    .replace(HEX_RE, '[hex]');
}
