import { sanitizeChatResponse } from './sanitize-chat-response';

/**
 * Tests del helper sanitizeChatResponse (Capa 2 del spec
 * admin-mcp-chat-ux-hardening § design.md).
 *
 * Cubre los 15 casos enumerados en el design (§ Capa 2 > Tests):
 *  1-3   CUIDs de Prisma reemplazados por `[id]`.
 *  4-6   Nombres internos de tools (`Tools:`, `Tool:`, inline `count_*`).
 *  7-9   Disclaimers de scoping multi-tenant (`Nota:`, `Aviso:`, `Importante:`).
 *   10   Disclaimer que NO menciona scoping/organización/permisos → preservado.
 *   11   Idempotencia: `sanitize(sanitize(x)).sanitized === sanitize(x).sanitized`.
 *   12   Input vacío.
 *   13   Sin matches → sanitized === raw (sin trim ni collapse necesarios).
 *   14   CUID dentro de URL → v1 matchea y reemplaza (comportamiento documentado
 *        y aceptado en design.md § "Anticipación senior — riesgos residuales").
 *   15   Multi-línea con CUID + disclaimer + tool_name → 3 filtros distintos aplicados.
 */
describe('sanitizeChatResponse', () => {
  describe('CUID replacement', () => {
    it('1. reemplaza CUID solo en string por [id]', () => {
      const raw = 'cm3a1abcdefghij1234567890';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('[id]');
      expect(filtersApplied).toEqual(['cuid']);
    });

    it('2. reemplaza CUID dentro de párrafo preservando contexto', () => {
      const raw = 'El ticket cm3a1abcdefghij1234567890 está cerrado.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('El ticket [id] está cerrado.');
      expect(filtersApplied).toEqual(['cuid']);
    });

    it('3. reemplaza múltiples CUIDs en una respuesta', () => {
      const raw =
        'Comparación: cm3a1abcdefghij1234567890 vs cm3b2xyzabcdefghij0987654321.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('Comparación: [id] vs [id].');
      expect(filtersApplied).toEqual(['cuid']);
    });
  });

  describe('tool name filtering', () => {
    it('4. elimina línea "Tools: count_clients, list_tickets" sin dejar blanco residual', () => {
      const raw = 'Tools: count_clients, list_tickets';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('');
      expect(filtersApplied).toContain('tool_name');
      // La línea "Tools:" completa se remueve antes de que corra tool_name_inline,
      // por lo que solo debe reportarse `tool_name`.
      expect(filtersApplied).not.toContain('tool_name_inline');
    });

    it('5. elimina línea "Tool: get_user"', () => {
      const raw = 'Tool: get_user';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('');
      expect(filtersApplied).toContain('tool_name');
    });

    it('6. elimina mención inline "use count_clients para contar" y colapsa espacios', () => {
      const raw = 'use count_clients para contar';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('use para contar');
      expect(filtersApplied).toContain('tool_name_inline');
    });
  });

  describe('multi-tenant disclaimer filtering', () => {
    it('7. elimina disclaimer "Nota: solo te muestro las de tu organización."', () => {
      const raw = 'Nota: solo te muestro las de tu organización.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('');
      expect(filtersApplied).toContain('disclaimer_nota');
    });

    it('8. elimina disclaimer "Aviso: filtrado por permisos."', () => {
      const raw = 'Aviso: filtrado por permisos.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('');
      expect(filtersApplied).toContain('disclaimer_aviso');
    });

    it('9. elimina disclaimer "Importante: solo organización."', () => {
      const raw = 'Importante: solo organización.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('');
      expect(filtersApplied).toContain('disclaimer_importante');
    });

    it('10. PRESERVA disclaimer que NO menciona scoping/organización/permisos', () => {
      // Regex exige keyword: organización|scoping|filtrado|permisos.
      // Este disclaimer legítimo (contexto de negocio) no debe filtrarse.
      const raw = 'Nota: ten en cuenta que el ticket está cerrado.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('Nota: ten en cuenta que el ticket está cerrado.');
      expect(filtersApplied).toEqual([]);
    });
  });

  describe('propiedades del sanitizer', () => {
    it('11. es idempotente: sanitize(sanitize(x)).sanitized === sanitize(x).sanitized', () => {
      const inputs = [
        'El ticket cm3a1abcdefghij1234567890 está cerrado.',
        'Tools: count_clients, list_tickets\nNota: solo te muestro las de tu organización.',
        'use count_clients para contar cm3a1abcdefghij1234567890.',
        'texto plano sin nada que sanear',
        '',
      ];

      for (const input of inputs) {
        const first = sanitizeChatResponse(input);
        const second = sanitizeChatResponse(first.sanitized);
        expect(second.sanitized).toBe(first.sanitized);
      }
    });

    it('12. input vacío devuelve { sanitized: "", filtersApplied: [] }', () => {
      expect(sanitizeChatResponse('')).toEqual({
        sanitized: '',
        filtersApplied: [],
      });
    });

    it('13. sin matches devuelve sanitized === raw y filtersApplied === []', () => {
      // Texto sin CUID, sin tool names, sin disclaimers de scoping,
      // sin whitespace en bordes ni espacios dobles internos.
      const raw = 'Tenés 5 clientes activos.';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe(raw);
      expect(filtersApplied).toEqual([]);
    });
  });

  describe('edge cases documentados', () => {
    it('14. CUID dentro de URL — v1 matchea y reemplaza (comportamiento aceptado en design)', () => {
      // El design.md § "Anticipación senior — riesgos residuales" documenta
      // que en v1 el regex \bc[a-z0-9]{24,}\b matchea CUIDs incluso dentro
      // de URLs, rompiendo el link. El UX target prohíbe CUIDs en cualquier
      // output al usuario, por lo que este comportamiento es aceptable v1.
      // La mitigación con preservación de markdown links es follow-up.
      const raw = 'https://linear.app/t/cm3a1xyzabcdefghij1234567';
      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);
      expect(sanitized).toBe('https://linear.app/t/[id]');
      expect(filtersApplied).toEqual(['cuid']);
    });

    it('15. multi-línea con CUID + disclaimer + tool_name → 3 filtros distintos aplicados', () => {
      const raw = [
        'Tenés 5 tickets. El ticket cm3a1abcdefghij1234567890 está abierto.',
        'Tools: count_tickets',
        'Nota: solo te muestro los de tu organización.',
      ].join('\n');

      const { sanitized, filtersApplied } = sanitizeChatResponse(raw);

      // Los 3 tipos distintos de filtro se aplican.
      expect(filtersApplied).toContain('cuid');
      expect(filtersApplied).toContain('tool_name');
      expect(filtersApplied).toContain('disclaimer_nota');
      expect(filtersApplied).toHaveLength(3);

      // El texto sobreviviente conserva la respuesta natural sin CUID crudo,
      // sin línea "Tools:" ni "Nota:" de scoping.
      expect(sanitized).toContain('Tenés 5 tickets.');
      expect(sanitized).toContain('[id]');
      expect(sanitized).not.toContain('cm3a1abcdefghij1234567890');
      expect(sanitized).not.toMatch(/^Tools:/m);
      expect(sanitized).not.toMatch(/^Nota:/m);
    });
  });
});
