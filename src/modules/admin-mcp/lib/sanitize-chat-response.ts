/**
 * Post-processing sanitizer for LLM chat responses (admin-mcp module).
 *
 * Aplica una batería de filtros regex sobre el `reply` final que va al
 * frontend para atrapar los patrones de fuga que el system prompt (capa 1)
 * no logró disciplinar:
 * - CUIDs de Prisma reemplazados por `[id]`.
 * - Líneas `Tools:` / `Tool:` eliminadas.
 * - Menciones inline de nombres internos de tools (`count_*`, `list_*`, `get_*`) eliminadas.
 * - Disclaimers de scoping multi-tenant (`Nota:` / `Aviso:` / `Importante:` + keyword) eliminados.
 *
 * La función es IDEMPOTENTE: `sanitize(sanitize(x)) === sanitize(x)`.
 *
 * Ver spec: harness-nestjs-next/specs/admin-mcp-chat-ux-hardening/design.md § Capa 2.
 */

export interface SanitizeChatResponseResult {
  sanitized: string;
  /**
   * Nombres de los filtros que hicieron al menos 1 match sobre el input.
   * Valores posibles:
   *  - 'cuid'
   *  - 'tool_name'
   *  - 'tool_name_inline'
   *  - 'disclaimer_nota'
   *  - 'disclaimer_aviso'
   *  - 'disclaimer_importante'
   */
  filtersApplied: string[];
}

interface FilterRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const FILTERS: FilterRule[] = [
  {
    name: 'cuid',
    pattern: /\bc[a-z0-9]{24,}\b/g,
    replacement: '[id]',
  },
  {
    name: 'tool_name',
    pattern: /^\s*Tools?\s*:\s*.+$/gim,
    replacement: '',
  },
  {
    name: 'tool_name_inline',
    pattern: /\b(count_[a-z_]+|list_[a-z_]+|get_[a-z_]+)\b/g,
    replacement: '',
  },
  {
    name: 'disclaimer_nota',
    pattern: /^\s*Nota:\s*.*(organizaci[oó]n|scoping|filtrad[oa]|permisos).*$/gim,
    replacement: '',
  },
  {
    name: 'disclaimer_aviso',
    pattern: /^\s*Aviso:\s*.*(organizaci[oó]n|scoping|filtrad[oa]|permisos).*$/gim,
    replacement: '',
  },
  {
    name: 'disclaimer_importante',
    pattern: /^\s*Importante:\s*.*(organizaci[oó]n|scoping|filtrad[oa]|permisos).*$/gim,
    replacement: '',
  },
];

export function sanitizeChatResponse(raw: string): SanitizeChatResponseResult {
  if (!raw) {
    return { sanitized: '', filtersApplied: [] };
  }

  const filtersApplied: string[] = [];
  let current = raw;

  for (const filter of FILTERS) {
    // Clonamos el regex con las mismas flags para evitar problemas de lastIndex
    // con regex globales al llamar .test() antes de .replace().
    const detectRegex = new RegExp(filter.pattern.source, filter.pattern.flags);
    if (detectRegex.test(current)) {
      filtersApplied.push(filter.name);
      const replaceRegex = new RegExp(filter.pattern.source, filter.pattern.flags);
      current = current.replace(replaceRegex, filter.replacement);
    }
  }

  // Post-cleanup: colapsar líneas en blanco múltiples y espacios dobles.
  current = current.replace(/\n{3,}/g, '\n\n');
  current = current.replace(/  +/g, ' ');
  current = current.trim();

  return { sanitized: current, filtersApplied };
}
