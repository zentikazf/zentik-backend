import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { TicketTypeService } from './ticket-type.service';

/**
 * Tests de TicketTypeService — ÁRBOL de tipos (feature #42, Fase 3 paso C).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real. A diferencia de los
 * specs hermanos, el mock está respaldado por un **catálogo en memoria**: las
 * escrituras se aplican de verdad sobre las filas, así los tests pueden afirmar el
 * estado FINAL del árbol (`path`/`level`/`isActive` de cada nodo) en vez de espiar
 * los argumentos de cada `update`. Es lo único que prueba de verdad un recálculo de
 * rama, que es un efecto sobre N filas.
 *
 * Cobertura (las reglas no negociables del blueprint §2 C):
 *  · `path`/`level` derivados al crear (raíz e hijo)
 *  · tope de 3 niveles, al crear Y al mover un subárbol completo
 *  · ciclos: padre = sí mismo y padre = un descendiente
 *  · desactivación en cascada de la rama + conteo
 *  · reactivar un hijo con el padre inactivo → rechazado
 *  · renombrar recalcula el path de TODOS los descendientes
 *  · `getTree` sin N+1 (una sola query)
 *  · scoping multi-tenant en todas las operaciones
 */

interface Row {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  isActive: boolean;
  parentId: string | null;
  path: string;
  level: number;
}

interface Where {
  id?: string;
  organizationId?: string;
  slug?: string;
  isActive?: boolean;
  path?: { startsWith: string };
}

interface FindArgs {
  where: Where;
  orderBy?: unknown;
}

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

describe('TicketTypeService (árbol)', () => {
  let service: TicketTypeService;
  let prisma: DeepMockProxy<PrismaService>;
  let catalog: Map<string, Row>;
  let created: number;

  /** Fila del catálogo con los defaults del schema (raíz activa). */
  const row = (partial: Partial<Row> & Pick<Row, 'id' | 'slug'>): Row => ({
    organizationId: ORG,
    name: partial.slug,
    isActive: true,
    parentId: null,
    path: partial.slug,
    level: 0,
    ...partial,
  });

  const seed = (...rows: Row[]): void => {
    for (const r of rows) {
      catalog.set(r.id, r);
    }
  };

  const get = (id: string): Row => {
    const found = catalog.get(id);
    if (!found) {
      throw new Error(`fixture inexistente: ${id}`);
    }
    return found;
  };

  const matches = (r: Row, where: Where): boolean => {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.organizationId !== undefined && r.organizationId !== where.organizationId) return false;
    if (where.slug !== undefined && r.slug !== where.slug) return false;
    if (where.isActive !== undefined && r.isActive !== where.isActive) return false;
    if (where.path?.startsWith !== undefined && !r.path.startsWith(where.path.startsWith)) return false;
    return true;
  };

  const sortRows = (rows: Row[], orderBy: unknown): Row[] => {
    // El service ordena por `level` (rama) o por `[path, name]` (catálogo).
    if (JSON.stringify(orderBy ?? null).includes('"level"')) {
      return [...rows].sort((a, b) => a.level - b.level);
    }
    return [...rows].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  };

  /**
   * Devuelve COPIAS, como Prisma: si devolviera las filas vivas del catálogo, el
   * service leería valores ya mutados por sus propias escrituras (aliasing que la
   * DB real nunca produce) y los tests probarían otra cosa.
   */
  const find = (args: FindArgs): Row[] =>
    sortRows(
      [...catalog.values()].filter((r) => matches(r, args.where)),
      args.orderBy,
    ).map((r) => ({ ...r }));

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TicketTypeService(prisma);
    catalog = new Map<string, Row>();
    created = 0;

    // `$transaction` interactiva: se ejecuta con el mismo mock como `tx` (patrón de
    // `client-billing.service.spec.ts`). No hay rollback: los tests que esperan un
    // rechazo verifican que la excepción salte ANTES de abrir la transacción.
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (tx: unknown) => unknown)(prisma),
    ) as never;

    prisma.ticketType.findFirst.mockImplementation(((args: FindArgs) =>
      Promise.resolve(find(args)[0] ?? null)) as never);

    prisma.ticketType.findMany.mockImplementation(((args: FindArgs) =>
      Promise.resolve(find(args))) as never);

    prisma.ticketType.create.mockImplementation(((args: { data: Partial<Row> }) => {
      const fresh: Row = {
        id: `new-${++created}`,
        organizationId: ORG,
        name: '',
        slug: '',
        isActive: true,
        parentId: null,
        path: '',
        level: 0,
        ...args.data,
      };
      catalog.set(fresh.id, fresh);
      return Promise.resolve({ ...fresh });
    }) as never);

    prisma.ticketType.update.mockImplementation(((args: { where: Where; data: Partial<Row> }) => {
      const target = catalog.get(args.where.id ?? '');
      if (!target) {
        return Promise.reject(new Error(`update de una fila inexistente: ${args.where.id}`));
      }
      Object.assign(target, args.data);
      return Promise.resolve({ ...target });
    }) as never);

    prisma.ticketType.updateMany.mockImplementation(((args: { where: Where; data: Partial<Row> }) => {
      const affected = [...catalog.values()].filter((r) => matches(r, args.where));
      for (const r of affected) {
        Object.assign(r, args.data);
      }
      return Promise.resolve({ count: affected.length });
    }) as never);
  });

  /**
   * Árbol de referencia (ORG):
   *   incidencia                                  (level 0)
   *   └── incidencia/error-del-sistema            (level 1)
   *       └── incidencia/error-del-sistema/base   (level 2)
   *   consulta                                    (level 0)
   */
  const seedTree = (): void =>
    seed(
      row({ id: 'incidencia', slug: 'incidencia', name: 'Incidencia' }),
      row({
        id: 'error',
        slug: 'error-del-sistema',
        name: 'Error del sistema',
        parentId: 'incidencia',
        path: 'incidencia/error-del-sistema',
        level: 1,
      }),
      row({
        id: 'base',
        slug: 'base-de-datos',
        name: 'Base de datos',
        parentId: 'error',
        path: 'incidencia/error-del-sistema/base-de-datos',
        level: 2,
      }),
      row({ id: 'consulta', slug: 'consulta', name: 'Consulta' }),
    );

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('sin parentId crea una RAÍZ: path = slug, level 0', async () => {
      const type = await service.create(ORG, { name: 'Incidencia' });

      expect(type).toMatchObject({ slug: 'incidencia', path: 'incidencia', level: 0, parentId: null });
    });

    it('con parentId calcula path = "padre/slug" y level = padre + 1', async () => {
      seedTree();

      const type = await service.create(ORG, { name: 'Error del sistema 2', parentId: 'incidencia' });

      expect(type).toMatchObject({
        slug: 'error-del-sistema-2',
        path: 'incidencia/error-del-sistema-2',
        level: 1,
        parentId: 'incidencia',
      });
    });

    it('un tercer nivel (level 2) es válido: el tope son 3 niveles', async () => {
      seedTree();

      const type = await service.create(ORG, { name: 'Timeout', parentId: 'error' });

      expect(type).toMatchObject({ path: 'incidencia/error-del-sistema/timeout', level: 2 });
    });

    it('un CUARTO nivel se rechaza con TICKET_TYPE_MAX_DEPTH (400)', async () => {
      seedTree();

      await expect(service.create(ORG, { name: 'Índices', parentId: 'base' })).rejects.toMatchObject({
        code: 'TICKET_TYPE_MAX_DEPTH',
        statusCode: 400,
      });
      expect(prisma.ticketType.create).not.toHaveBeenCalled();
    });

    it('SCOPING: un padre de OTRA organización responde TICKET_TYPE_NOT_FOUND (404)', async () => {
      seedTree();
      seed(row({ id: 'ajeno', slug: 'ajeno', organizationId: OTHER_ORG }));

      await expect(service.create(ORG, { name: 'Colgado', parentId: 'ajeno' })).rejects.toMatchObject({
        code: 'TICKET_TYPE_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.ticketType.create).not.toHaveBeenCalled();
    });

    it('un padre INACTIVO no puede recibir hijos (TICKET_TYPE_PARENT_INACTIVE)', async () => {
      seedTree();
      get('incidencia').isActive = false;

      await expect(
        service.create(ORG, { name: 'Nuevo', parentId: 'incidencia' }),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_PARENT_INACTIVE', statusCode: 400 });
    });
  });

  // ── ciclos ───────────────────────────────────────────────────────────────

  describe('update — ciclos', () => {
    it('un tipo NO puede ser su propio padre (TICKET_TYPE_CYCLE)', async () => {
      seedTree();

      await expect(
        service.update(ORG, 'incidencia', { parentId: 'incidencia' }),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_CYCLE', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un tipo NO puede colgar de un DESCENDIENTE suyo (TICKET_TYPE_CYCLE)', async () => {
      seedTree();

      // incidencia → hijo de su propio nieto
      await expect(service.update(ORG, 'incidencia', { parentId: 'base' })).rejects.toMatchObject({
        code: 'TICKET_TYPE_CYCLE',
        statusCode: 400,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(get('incidencia').parentId).toBeNull();
    });

    it('mover a un tipo NO emparentado es válido y no dispara el guard de ciclos', async () => {
      seedTree();

      await service.update(ORG, 'consulta', { parentId: 'incidencia' });

      expect(get('consulta')).toMatchObject({
        parentId: 'incidencia',
        path: 'incidencia/consulta',
        level: 1,
      });
    });
  });

  // ── profundidad al mover ─────────────────────────────────────────────────

  describe('update — profundidad de la RAMA al mover', () => {
    it('mover un subárbol que empujaría a un descendiente al 4º nivel se rechaza', async () => {
      seedTree();

      // `incidencia` sola entraría (pasaría a level 1), pero arrastra 2 niveles más.
      await expect(
        service.update(ORG, 'incidencia', { parentId: 'consulta' }),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_MAX_DEPTH', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(get('base').level).toBe(2);
    });

    it('mover una HOJA bajo otro padre de nivel 1 sí entra (queda en level 2)', async () => {
      seedTree();

      await service.update(ORG, 'base', { parentId: 'error' });

      expect(get('base')).toMatchObject({ level: 2 });
    });

    it('mover una rama a RAÍZ (parentId null) recalcula path y level de TODA la rama', async () => {
      seedTree();

      await service.update(ORG, 'error', { parentId: null });

      expect(get('error')).toMatchObject({
        parentId: null,
        path: 'error-del-sistema',
        level: 0,
      });
      expect(get('base')).toMatchObject({
        path: 'error-del-sistema/base-de-datos',
        level: 1,
      });
    });
  });

  // ── renombrar ────────────────────────────────────────────────────────────

  describe('update — renombrar', () => {
    it('cambiar el slug recalcula el path del nodo Y de todos sus descendientes', async () => {
      seedTree();

      await service.update(ORG, 'incidencia', { name: 'Incidencias', slug: 'incidencias' });

      expect(get('incidencia')).toMatchObject({ path: 'incidencias', level: 0 });
      expect(get('error')).toMatchObject({ path: 'incidencias/error-del-sistema', level: 1 });
      expect(get('base')).toMatchObject({
        path: 'incidencias/error-del-sistema/base-de-datos',
        level: 2,
      });
      // el nivel no cambia al renombrar: solo el prefijo del path
      expect(get('consulta').path).toBe('consulta');
    });

    it('cambiar SOLO el nombre no toca el slug ni el path (no recalcula la rama)', async () => {
      seedTree();

      await service.update(ORG, 'incidencia', { name: 'Incidencias del sistema' });

      expect(get('incidencia')).toMatchObject({
        name: 'Incidencias del sistema',
        slug: 'incidencia',
        path: 'incidencia',
      });
      expect(get('error').path).toBe('incidencia/error-del-sistema');
    });
  });

  // ── desactivación en cascada ─────────────────────────────────────────────

  describe('deactivate — cascada de la rama', () => {
    it('desactivar un padre apaga TODA su rama y devuelve el conteo (incluido el propio)', async () => {
      seedTree();

      await expect(service.deactivate(ORG, 'incidencia')).resolves.toEqual({ deactivated: 3 });

      expect(get('incidencia').isActive).toBe(false);
      expect(get('error').isActive).toBe(false);
      expect(get('base').isActive).toBe(false);
      // una rama hermana no se toca
      expect(get('consulta').isActive).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('los que ya estaban inactivos no se cuentan (repetir la baja devuelve 0)', async () => {
      seedTree();

      await service.deactivate(ORG, 'incidencia');
      await expect(service.deactivate(ORG, 'incidencia')).resolves.toEqual({ deactivated: 0 });
    });

    it('desactivar una HOJA devuelve 1 y no toca a sus ancestros', async () => {
      seedTree();

      await expect(service.deactivate(ORG, 'base')).resolves.toEqual({ deactivated: 1 });
      expect(get('incidencia').isActive).toBe(true);
      expect(get('error').isActive).toBe(true);
    });

    it('SCOPING: una rama homónima de OTRA organización queda intacta', async () => {
      seedTree();
      seed(
        row({
          id: 'ajeno-hijo',
          slug: 'error-ajeno',
          organizationId: OTHER_ORG,
          path: 'incidencia/error-ajeno',
          level: 1,
        }),
      );

      await expect(service.deactivate(ORG, 'incidencia')).resolves.toEqual({ deactivated: 3 });
      expect(get('ajeno-hijo').isActive).toBe(true);
    });

    it('un tipo de otra organización no se puede desactivar (TICKET_TYPE_NOT_FOUND)', async () => {
      seed(row({ id: 'ajeno', slug: 'ajeno', organizationId: OTHER_ORG }));

      await expect(service.deactivate(ORG, 'ajeno')).rejects.toMatchObject({
        code: 'TICKET_TYPE_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('PATCH isActive:false también apaga la rama (no es un desvío para dejar huérfanos)', async () => {
      seedTree();

      await service.update(ORG, 'incidencia', { isActive: false });

      expect(get('error').isActive).toBe(false);
      expect(get('base').isActive).toBe(false);
    });
  });

  // ── reactivación ─────────────────────────────────────────────────────────

  describe('update — reactivar', () => {
    it('reactivar un hijo con el padre INACTIVO se rechaza (TICKET_TYPE_PARENT_INACTIVE)', async () => {
      seedTree();
      await service.deactivate(ORG, 'incidencia');

      await expect(service.update(ORG, 'error', { isActive: true })).rejects.toMatchObject({
        code: 'TICKET_TYPE_PARENT_INACTIVE',
        statusCode: 400,
      });
      expect(get('error').isActive).toBe(false);
    });

    it('reactivar un hijo con el padre ACTIVO funciona', async () => {
      seedTree();
      await service.deactivate(ORG, 'error');

      await service.update(ORG, 'error', { isActive: true });

      expect(get('error').isActive).toBe(true);
    });

    it('reactivar una RAÍZ nunca se bloquea (no tiene padre)', async () => {
      seedTree();
      await service.deactivate(ORG, 'consulta');

      await service.update(ORG, 'consulta', { isActive: true });

      expect(get('consulta').isActive).toBe(true);
    });
  });

  // ── lectura: list plano + getTree ────────────────────────────────────────

  describe('list', () => {
    it('ordena por path: cada padre queda inmediatamente antes de su rama', async () => {
      seedTree();

      const types = await service.list(ORG);

      expect(types.map((t) => t.path)).toEqual([
        'consulta',
        'incidencia',
        'incidencia/error-del-sistema',
        'incidencia/error-del-sistema/base-de-datos',
      ]);
      expect(prisma.ticketType.findMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: ORG, isActive: true },
        orderBy: [{ path: 'asc' }, { name: 'asc' }],
      });
    });

    it('includeInactive trae también los apagados', async () => {
      seedTree();
      await service.deactivate(ORG, 'consulta');

      await expect(service.list(ORG)).resolves.toHaveLength(3);
      await expect(service.list(ORG, true)).resolves.toHaveLength(4);
    });
  });

  describe('getTree', () => {
    it('arma la jerarquía anidada con UNA sola query (sin N+1)', async () => {
      seedTree();

      const tree = await service.getTree(ORG);

      expect(prisma.ticketType.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.ticketType.findFirst).not.toHaveBeenCalled();
      expect(tree.map((node) => node.id)).toEqual(['consulta', 'incidencia']);

      const incidencia = tree[1];
      expect(incidencia.children.map((node) => node.id)).toEqual(['error']);
      expect(incidencia.children[0].children.map((node) => node.id)).toEqual(['base']);
      expect(incidencia.children[0].children[0].children).toEqual([]);
    });

    it('SCOPING: no mezcla el árbol de otra organización', async () => {
      seedTree();
      seed(row({ id: 'ajeno', slug: 'ajeno', organizationId: OTHER_ORG }));

      const tree = await service.getTree(ORG);

      expect(tree.map((node) => node.id)).toEqual(['consulta', 'incidencia']);
    });

    it('un hijo cuyo padre quedó filtrado (inactivo) sube a raíz en vez de desaparecer', async () => {
      seedTree();
      // Estado anómalo a propósito (la cascada lo impide): padre apagado, hijo vivo.
      get('incidencia').isActive = false;

      const tree = await service.getTree(ORG);

      expect(tree.map((node) => node.id)).toEqual(['consulta', 'error']);
      expect(tree[1].children.map((node) => node.id)).toEqual(['base']);
    });
  });

  // ── contrato de errores ──────────────────────────────────────────────────

  it('todos los rechazos del árbol son AppException (los toma el filtro global)', async () => {
    seedTree();

    await expect(service.update(ORG, 'incidencia', { parentId: 'incidencia' })).rejects.toBeInstanceOf(
      AppException,
    );
    await expect(service.create(ORG, { name: 'X', parentId: 'base' })).rejects.toBeInstanceOf(
      AppException,
    );
  });
});
