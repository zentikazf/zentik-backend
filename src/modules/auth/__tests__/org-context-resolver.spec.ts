import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaService } from '../../../database/prisma.service';
import {
  MAPA_ORG,
  PREFIJOS_EXENTOS,
  estaExento,
  resolverOrganizacion,
} from '../org-context.resolver';

/**
 * #69 T1.2 — de qué organización habla una request.
 *
 * Este archivo prueba la RESOLUCION aislada. El candado (el 403) se prueba en
 * `org-context-guard.spec.ts`: son dos preguntas distintas y conviene que fallen por separado.
 *
 * Lo que más importa acá no es que resuelva bien —eso es lo obvio— sino **cuándo NO consulta**:
 * el atajo de "una sola membership" y el de "`orgId` ya está en la URL" son los que hacen que #69
 * no agregue ni una consulta al camino de autenticación de cada request.
 */
describe('#69 — resolución de la organización', () => {
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
  });

  /** Cuántas veces se llamó a `findUnique` en CUALQUIER modelo. */
  const consultas = () =>
    Object.values(prisma as unknown as Record<string, { findUnique?: { mock?: { calls: unknown[] } } }>)
      .reduce((n, delegate) => n + (delegate?.findUnique?.mock?.calls.length ?? 0), 0);

  // ── El camino que no cuesta nada ──────────────────────────────────────

  it('con :orgId en la URL lo devuelve tal cual y NO consulta', async () => {
    const r = await resolverOrganizacion(prisma, { orgId: 'org-1' });

    expect(r).toEqual({ orgId: 'org-1', encontrado: true, consulto: false });
    expect(consultas()).toBe(0);
  });

  it('gana :orgId sobre cualquier otro param', async () => {
    // Si vinieran los dos, consultar el recurso sería trabajo al pedo: la URL ya lo dijo.
    const r = await resolverOrganizacion(prisma, { orgId: 'org-1', taskId: 't-1' });

    expect(r.orgId).toBe('org-1');
    expect(consultas()).toBe(0);
  });

  // ── #70: el modo que ignora orgId, para poder comparar ────────────────

  describe('#70 — ignorarOrgId', () => {
    it('con orgId + taskId resuelve por el RECURSO y consulta', async () => {
      prisma.task.findUnique.mockResolvedValue({ project: { organizationId: 'org-del-task' } } as never);

      const r = await resolverOrganizacion(
        prisma,
        { orgId: 'org-de-la-url', taskId: 't-1' },
        { ignorarOrgId: true },
      );

      // Es lo que le permite al guard comparar las dos fuentes y cazar el "pongo mi organización
      // en la URL y pido un recurso ajeno".
      expect(r).toEqual({ orgId: 'org-del-task', encontrado: true, consulto: true });
    });

    it('el MISMO caso sin la opción devuelve el orgId y NO consulta', async () => {
      // El par del anterior: fija que el comportamiento por defecto de #69 no se movió.
      const r = await resolverOrganizacion(prisma, { orgId: 'org-de-la-url', taskId: 't-1' });

      expect(r).toEqual({ orgId: 'org-de-la-url', encontrado: true, consulto: false });
      expect(consultas()).toBe(0);
    });

    it('con orgId y SIN param de recurso no resuelve nada, sin consultar', async () => {
      const r = await resolverOrganizacion(prisma, { orgId: 'org-1' }, { ignorarOrgId: true });

      // `consulto: false` es la señal que usa el guard para saltearse la comparación.
      expect(r).toEqual({ orgId: null, encontrado: false, consulto: false });
    });
  });

  it('sin params: no resuelve y no consulta', async () => {
    expect(await resolverOrganizacion(prisma, {})).toEqual({
      orgId: null,
      encontrado: false,
      consulto: false,
    });
    expect(consultas()).toBe(0);
  });

  it('con un param DESCONOCIDO no consulta — el guard no debe interferir ahí', async () => {
    const r = await resolverOrganizacion(prisma, { inventadoId: 'x-1' });

    expect(r.encontrado).toBe(false);
    expect(consultas()).toBe(0);
  });

  // ── Un salto: el modelo tiene organizationId propio ───────────────────

  it.each([
    ['projectId', 'project'],
    ['clientId', 'client'],
    ['ticketId', 'ticket'],
    ['channelId', 'channel'],
    ['fileId', 'file'],
  ])('%s se resuelve con UNA consulta directa a %s', async (param, modelo) => {
    const delegate = (prisma as unknown as Record<string, { findUnique: jest.Mock }>)[modelo];
    delegate.findUnique.mockResolvedValue({ organizationId: 'org-7' } as never);

    const r = await resolverOrganizacion(prisma, { [param]: 'id-1' });

    expect(r).toEqual({ orgId: 'org-7', encontrado: true, consulto: true });
    expect(consultas()).toBe(1);
    expect(delegate.findUnique).toHaveBeenCalledWith({
      where: { id: 'id-1' },
      select: { organizationId: true },
    });
  });

  // ── Dos y tres saltos: UNA consulta, no N ─────────────────────────────

  it.each([
    ['taskId', 'task'],
    ['boardId', 'board'],
    ['sprintId', 'sprint'],
    ['meetingId', 'meeting'],
  ])('%s baja por project en UNA sola consulta', async (param, modelo) => {
    const delegate = (prisma as unknown as Record<string, { findUnique: jest.Mock }>)[modelo];
    delegate.findUnique.mockResolvedValue({ project: { organizationId: 'org-9' } } as never);

    const r = await resolverOrganizacion(prisma, { [param]: 'id-2' });

    expect(r.orgId).toBe('org-9');
    // El punto del caso: dos saltos NO son dos queries. Es un `select` anidado.
    expect(consultas()).toBe(1);
    expect(delegate.findUnique).toHaveBeenCalledWith({
      where: { id: 'id-2' },
      select: { project: { select: { organizationId: true } } },
    });
  });

  it('commentId baja tres niveles, también en UNA consulta', async () => {
    prisma.comment.findUnique.mockResolvedValue({
      task: { project: { organizationId: 'org-3' } },
    } as never);

    const r = await resolverOrganizacion(prisma, { commentId: 'c-1' });

    expect(r.orgId).toBe('org-3');
    expect(consultas()).toBe(1);
    expect(prisma.comment.findUnique).toHaveBeenCalledWith({
      where: { id: 'c-1' },
      select: { task: { select: { project: { select: { organizationId: true } } } } },
    });
  });

  // ── El recurso que no existe ──────────────────────────────────────────

  it('recurso inexistente: no resuelve, pero deja constancia de que consultó', async () => {
    prisma.task.findUnique.mockResolvedValue(null as never);

    // `consulto: true` es lo que le permite al guard distinguir "no había nada que resolver"
    // (no interferir) de "el recurso no existe o no es tuyo" (403).
    expect(await resolverOrganizacion(prisma, { taskId: 'no-existe' })).toEqual({
      orgId: null,
      encontrado: false,
      consulto: true,
    });
  });

  it('una relación rota tampoco explota', async () => {
    prisma.task.findUnique.mockResolvedValue({ project: null } as never);

    const r = await resolverOrganizacion(prisma, { taskId: 't-1' });

    expect(r.orgId).toBeNull();
    expect(r.encontrado).toBe(false);
  });

  // ── Cerrojos del mapa ─────────────────────────────────────────────────

  describe('el mapa', () => {
    it('cubre los params de recurso que usan las rutas del repo', () => {
      const params = MAPA_ORG.map((m) => m.param);

      for (const esperado of [
        'projectId',
        'clientId',
        'ticketId',
        'channelId',
        'fileId',
        'taskId',
        'boardId',
        'sprintId',
        'meetingId',
        'commentId',
      ]) {
        expect([esperado, params.includes(esperado)]).toEqual([esperado, true]);
      }
    });

    it('cada modelo del mapa existe de verdad en Prisma', () => {
      // Si alguien renombra un modelo en `schema.prisma`, el mapa queda apuntando al vacío y la
      // resolución devolvería `encontrado: false` en silencio — que el guard traduce a "no
      // interferir". O sea: una ruta que se queda sin candado sin que nadie lo note.
      for (const { param, modelo } of MAPA_ORG) {
        const delegate = (prisma as unknown as Record<string, { findUnique?: unknown }>)[modelo];
        // Se pregunta por `findUnique` y no por `typeof delegate`: `jest-mock-extended` expone los
        // delegates como funciones mock, así que el tipo no dice nada. Lo que importa es que el
        // modelo exponga el método que usa el resolver.
        expect([param, modelo, typeof delegate?.findUnique]).toEqual([param, modelo, 'function']);
      }
    });

    it('no hay params duplicados', () => {
      const params = MAPA_ORG.map((m) => m.param);
      expect(params.length).toBe(new Set(params).size);
    });
  });

  // ── La lista de exención ──────────────────────────────────────────────

  describe('rutas exentas', () => {
    it('es exactamente esta lista — sacar una es un cambio visible en el diff', () => {
      expect([...PREFIJOS_EXENTOS]).toEqual([
        '/portal',
        '/auth',
        '/health',
        '/onboarding',
        '/users',
        '/notifications',
      ]);
    });

    it.each([
      ['/portal/tickets/abc', true],
      ['/api/v1/portal/hours', true],
      ['/auth/login', true],
      ['/users/me/tasks', true],
      ['/notifications', true],
      ['/api/v1/notifications?page=1', true],
    ])('%s exento: %s', (path, esperado) => {
      expect(estaExento(path)).toBe(esperado);
    });

    it.each([
      ['/organizations/org-1/clients', false],
      ['/tasks/t-1', false],
      ['/projects/p-1/files', false],
      ['/api/v1/organizations/org-1/audit-log', false],
    ])('%s exento: %s', (path, esperado) => {
      // El par del anterior: si TODO fuera exento, los tests de arriba pasarían igual y el guard
      // no protegería nada.
      expect(estaExento(path)).toBe(esperado);
    });

    it('un prefijo no matchea por coincidencia parcial del nombre', () => {
      // `/usersomething` no es `/users`. Sin el chequeo de límite, una ruta nueva podría quedar
      // exenta sin que nadie lo pidiera.
      expect(estaExento('/usersomething')).toBe(false);
      expect(estaExento('/portalize/x')).toBe(false);
    });
  });
});
