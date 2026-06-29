/**
 * Sanitiza los `args` que el LLM envia a una tool antes de serializarlos al
 * frontend (ChatOutputDto.toolCalls.args) y antes de loggearlos en el backend
 * (admin-mcp.tool.call.start/end). Feature #15 — Capa 5 (R33, R34).
 *
 * Estrategia:
 *  - Recorre las keys con `MAX_DEPTH` (3 = top-level + un objeto anidado
 *    + un campo anidado dentro). Cubre la forma tipica del MCP de Zentik:
 *    `{ entity, where: { OR: [{ email: ... }] } }`. Mas alla de eso,
 *    se sustituye por `'[object]'` para evitar payloads enormes y prevenir
 *    PII oculto.
 *  - Si la key matchea SENSITIVE_KEY_REGEX, el valor se reemplaza por
 *    `"[redacted]"` (string literal, asi mantiene el shape pero sin filtrar
 *    el valor crudo).
 *  - Los names de las keys se preservan: el LLM y el frontend necesitan ver
 *    la estructura para razonar/explicar; lo que NO debe filtrarse es el
 *    valor (que puede contener emails, tokens, dni, etc.).
 *
 * NOTA: este helper opera sobre datos opacos (Record<string, unknown>) sin
 * type narrowing. La defensa principal contra leaks de datos sensibles
 * proviene de `FIELD_EXCLUSIONS` del MCP — esto es defense-in-depth.
 */

const SENSITIVE_KEY_REGEX =
  /(email|phone|password|token|secret|apikey|api_key|api-key|url|notes|admin[Nn]otes|close[Nn]ote|dni|cuit|cuil|ssn|hash|cookie|authorization|bearer|priceAmount|priceRate)/i;

const REDACTED = '[redacted]';
// Max profundidad de containers (objects/arrays). El root cuenta como
// depth 0; un object anidado dentro del root es depth 1; etc. Cubre la
// forma tipica del MCP: `{ entity, where: { OR: [{ email: ... }] } }`
// (root depth 0 -> where depth 1 -> OR depth 2 -> objeto interno depth 2).
const MAX_DEPTH = 2;

/**
 * Sanitiza un value que ESTA dentro de un container (object/array). El
 * caller ya verifico la sensibilidad de la KEY que apunta a este value.
 * `depth` representa cuantos containers se recorrieron para llegar aca;
 * cuando supera MAX_DEPTH, se reemplaza por `'[object]'` (para containers)
 * o se preserva (para primitivos).
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  // Primitivos pasan tal cual sin importar la profundidad.
  if (typeof value !== 'object') return value;

  if (depth > MAX_DEPTH) {
    return '[object]';
  }

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }

  // Objeto plano: aplicar mismo recorrido key-by-key.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitizeValue(v, depth + 1);
    }
  }
  return out;
}

/**
 * Sanitiza recursivamente (max MAX_DEPTH niveles) el objeto de args.
 * Devuelve una copia nueva; no muta el input. Si el input no es un objeto,
 * devuelve `{}`.
 */
export function sanitizeToolArgs(
  args: unknown,
): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitizeValue(v, 1);
    }
  }
  return out;
}

/**
 * Variante para logging: devuelve SOLO las keys top-level + un sumario del
 * tipo del valor. NUNCA serializa el valor en si mismo. Util para
 * admin-mcp.tool.call.start/end log entries.
 */
export function summarizeToolArgsForLog(
  args: unknown,
): { argsKeys: string[]; argsTypes: Record<string, string> } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { argsKeys: [], argsTypes: {} };
  }
  const obj = args as Record<string, unknown>;
  const argsKeys = Object.keys(obj);
  const argsTypes: Record<string, string> = {};
  for (const k of argsKeys) {
    const v = obj[k];
    if (v === null) argsTypes[k] = 'null';
    else if (Array.isArray(v)) argsTypes[k] = 'array';
    else argsTypes[k] = typeof v;
  }
  return { argsKeys, argsTypes };
}
