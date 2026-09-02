import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  MAX_PAGE,
  paginationQueryDto,
  cursorPaginationQueryDto,
} from '../dto/pagination-query.dto';

/**
 * #67 T1.2 — el DTO base de paginación.
 *
 * EL BUG QUE CIERRA: ocho endpoints hacían `page ? parseInt(page, 10) : 1`. El ternario evalúa el
 * STRING, que es truthy, así que `?page=abc` entraba al `parseInt` y propagaba `NaN`. El default
 * de la firma del service (`page = 1`) no protege: sólo cubre `undefined`. Prisma recibía
 * `take: NaN` ⇒ HTTP 500. Ninguno de los cinco services tenía clamp.
 *
 * Se valida con `plainToInstance` + `validateSync` —lo mismo que hace el ValidationPipe global—
 * en vez de levantar Nest: es el mismo camino de código, sin el árbol de dependencias.
 *
 * Los valores llegan como STRING, siempre: es lo que entrega Express en `req.query`. Por eso
 * todos los casos de abajo pasan strings, no números — testear con números no probaría el
 * `@Type(() => Number)`, que es justo la pieza que faltaba.
 */
describe('PaginationQueryDto (#67)', () => {
  class Dto extends paginationQueryDto({ defaultLimit: 20, maxLimit: 100 }) {}

  const validar = (query: Record<string, unknown>) => {
    const dto = plainToInstance(Dto, query, { enableImplicitConversion: true });
    return { dto, errores: validateSync(dto as object) };
  };

  const propiedadesConError = (query: Record<string, unknown>) =>
    validar(query).errores.map((e) => e.property);

  // ── Defaults: el camino que usan casi todas las pantallas ─────────────

  it('sin query params: válido, y quedan los defaults', () => {
    const { dto, errores } = validar({});

    expect(errores).toHaveLength(0);
    expect([dto.page, dto.limit]).toEqual([1, 20]);
  });

  it('el defaultLimit es el que se le pidió a la factory, no uno global', () => {
    class Otro extends paginationQueryDto({ defaultLimit: 50, maxLimit: 200 }) {}
    const dto = plainToInstance(Otro, {}, { enableImplicitConversion: true });

    expect(dto.limit).toBe(50);
  });

  // ── El NaN, que es el bug original ────────────────────────────────────

  it.each([
    ['page', { page: 'abc' }],
    ['limit', { limit: 'abc' }],
  ])('%s = "abc" es RECHAZADO — antes propagaba NaN hasta Prisma y daba 500', (prop, query) => {
    expect(propiedadesConError(query)).toContain(prop);
  });

  it.each([['10abc'], ['  '], ['Infinity'], ['NaN'], ['null'], ['[]']])(
    'basura sintáctica rechazada: limit=%s',
    (valor) => {
      expect(propiedadesConError({ limit: valor })).toContain('limit');
    },
  );

  /**
   * Comportamiento REAL, documentado para que no sorprenda: `enableImplicitConversion`
   * (main.ts:77) usa `Number()`, que lee el string COMPLETO — no corta en el primer caracter no
   * numérico como hacía `parseInt`. Es la misma diferencia que #57 ya dejó anotada en
   * `client.controller.ts:47-53` para `parsePaginationParam`, o sea que el repo ya convive con
   * esto. No es un agujero: lo que sale es un entero, y el piso y el techo lo siguen acotando.
   */
  it.each([
    ['0x10 (hexadecimal)', '0x10', 16],
    ['1e2 (notación científica)', '1e2', 100],
    ['espacios en los bordes', ' 30 ', 30],
  ])('%s se interpreta como número y pasa si cae en rango', (_caso, valor, esperado) => {
    const { dto, errores } = validar({ limit: valor });

    expect(errores).toHaveLength(0);
    expect(dto.limit).toBe(esperado);
  });

  it('...pero si esa interpretación excede el techo, se rechaza igual', () => {
    // `1e3` es 1000: entero válido, fuera de rango. Lo frena el @Max, no el @IsInt.
    expect(propiedadesConError({ limit: '1e3' })).toContain('limit');
  });

  // ── Piso ──────────────────────────────────────────────────────────────

  it.each([
    ['page', '0'],
    ['page', '-1'],
    ['limit', '0'],
    ['limit', '-1'],
  ])('%s = %s es rechazado (piso)', (prop, valor) => {
    expect(propiedadesConError({ [prop]: valor })).toContain(prop);
  });

  it('el decimal se rechaza en vez de truncarse en silencio', () => {
    // `parseInt('1.9')` daba 1 sin avisar. `@IsInt` lo rechaza: si el cliente manda una página
    // fraccionaria, es un bug del cliente y conviene que se entere.
    expect(propiedadesConError({ page: '1.9' })).toContain('page');
  });

  // ── Techo: el borde va con su par ─────────────────────────────────────

  it('limit = maxLimit exacto es VALIDO', () => {
    expect(propiedadesConError({ limit: '100' })).toEqual([]);
  });

  it('limit = maxLimit + 1 es rechazado', () => {
    // Los dos casos juntos fijan el borde. Sólo el segundo pasaría igual con el techo corrido
    // en uno, que es el error clásico de un `@Max` mal puesto.
    expect(propiedadesConError({ limit: '101' })).toContain('limit');
  });

  it('limit = 1000000 es rechazado — antes devolvía la tabla entera', () => {
    expect(propiedadesConError({ limit: '1000000' })).toContain('limit');
  });

  it('page = MAX_PAGE exacto es válido, MAX_PAGE + 1 no', () => {
    expect(propiedadesConError({ page: String(MAX_PAGE) })).toEqual([]);
    expect(propiedadesConError({ page: String(MAX_PAGE + 1) })).toContain('page');
  });

  it('page = 99999999999999999999 es rechazado — antes desbordaba el int64 de Postgres', () => {
    expect(propiedadesConError({ page: '99999999999999999999' })).toContain('page');
  });

  // ── Los valores buenos siguen pasando ─────────────────────────────────

  it('?page=2&limit=30 se transforma a números y pasa', () => {
    const { dto, errores } = validar({ page: '2', limit: '30' });

    expect(errores).toHaveLength(0);
    expect([dto.page, dto.limit]).toEqual([2, 30]);
    expect(typeof dto.page).toBe('number');
  });

  // ── La variante por cursor ────────────────────────────────────────────

  describe('CursorPaginationQueryDto', () => {
    class CursorDto extends cursorPaginationQueryDto({ defaultLimit: 50, maxLimit: 100 }) {}

    const validarCursor = (query: Record<string, unknown>) => {
      const dto = plainToInstance(CursorDto, query, { enableImplicitConversion: true });
      return { dto, errores: validateSync(dto as object) };
    };

    it('sin params: cursor undefined y limit en su default', () => {
      const { dto, errores } = validarCursor({});

      expect(errores).toHaveLength(0);
      expect([dto.cursor, dto.limit]).toEqual([undefined, 50]);
    });

    it('acepta un cursor string', () => {
      const { dto, errores } = validarCursor({ cursor: 'clx123', limit: '30' });

      expect(errores).toHaveLength(0);
      expect([dto.cursor, dto.limit]).toEqual(['clx123', 30]);
    });

    it('NO declara page: paginar por offset acá no tiene sentido', () => {
      // El service filtra con `where.id = { lt: cursor }` (chat.service.ts:379-380), no con skip.
      // Con `forbidNonWhitelisted` (main.ts:74), mandar `?page=` devuelve 400 — que es lo
      // correcto: avisa que ese parámetro no existe en vez de ignorarlo en silencio.
      expect('page' in validarCursor({}).dto).toBe(false);
    });

    it('limit sigue teniendo piso y techo', () => {
      expect(validarCursor({ limit: 'abc' }).errores).not.toHaveLength(0);
      expect(validarCursor({ limit: '0' }).errores).not.toHaveLength(0);
      expect(validarCursor({ limit: '101' }).errores).not.toHaveLength(0);
    });

    it('limit=100 es VALIDO — el portal pide exactamente eso', () => {
      // portal/tickets/[ticketId]/page.tsx:129. Si el techo bajara a 50, esa pantalla se caería
      // con 400. Este caso existe para que nadie lo baje sin darse cuenta.
      expect(validarCursor({ limit: '100' }).errores).toHaveLength(0);
    });
  });
});
