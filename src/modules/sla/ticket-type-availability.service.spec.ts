import { TicketCriticality } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { TicketTypeAvailabilityService } from './ticket-type-availability.service';

/**
 * Tests de TicketTypeAvailabilityService (#42 Fase 2 + #48 T3/T4).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Foco:
 *  · #42 — contratos vs. modo permisivo vs. filtro por criticidad + scoping.
 *  · #48 T3 — la audiencia. El ojito (`clientVisible`) SOLO filtra la lectura del
 *    cliente, y filtra DENTRO del `where` en LAS DOS ramas. El caso que justifica
 *    esto último tiene test propio: un proyecto cuyos contratos apuntan TODOS a
 *    carpetas ocultas tiene que caer a permisivo, no devolver un selector vacío
 *    diciendo que está configurado.
 *  · #48 T4 — los ancestros se resuelven en el backend, y uno oculto no aporta su
 *    nombre al cliente.
 */
describe('TicketTypeAvailabilityService', () => {
  let service: TicketTypeAvailabilityService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const PROJECT = 'project-1';

  // Tipos tal como los devuelve el `select` de disponibilidad.
  const incidencia = { id: 'type-inc', name: 'Incidencia', slug: 'incidencia', parentId: null };
  const consulta = { id: 'type-con', name: 'Consulta', slug: 'consulta', parentId: null };
  const mejora = { id: 'type-mej', name: 'Mejora', slug: 'mejora', parentId: null };
  const errorSistema = {
    id: 'type-err',
    name: 'Error del sistema',
    slug: 'error-del-sistema',
    parentId: 'type-inc',
  };

  /** Lo mismo, ya con el `ancestorNames` que agrega el servicio. */
  const withRootAncestors = <T extends { id: string; name: string; slug: string }>(t: T) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    ancestorNames: [],
  });

  /**
   * `prisma.ticketType.findMany` se usa para DOS cosas: la rama permisiva y el
   * catálogo completo que resuelve los ancestros. Se distinguen por el `select`
   * (solo el del catálogo pide `clientVisible`).
   */
  function mockTicketTypeQueries(opts: {
    permissive?: unknown[];
    catalog?: unknown[];
  }) {
    prisma.ticketType.findMany.mockImplementation((args: unknown) => {
      const select = (args as { select?: Record<string, boolean> }).select ?? {};
      const rows = select.clientVisible ? (opts.catalog ?? []) : (opts.permissive ?? []);
      return Promise.resolve(rows) as never;
    });
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new TicketTypeAvailabilityService(prisma);
    // Catálogo vacío por defecto: sin ancestros que resolver.
    mockTicketTypeQueries({});
  });

  describe('getAvailableTypes — proyecto CON contratos', () => {
    it('devuelve SOLO los tipos contratados (ordenados por nombre) y fallback=false', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
        { ticketType: consulta },
      ] as never);

      await expect(
        service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' }),
      ).resolves.toEqual({
        types: [withRootAncestors(consulta), withRootAncestors(incidencia)],
        fallback: false,
      });
      // No se consulta el catálogo como LISTA permisiva: el contrato manda. (Sí se
      // lo consulta para los ancestros, con otro `select`.)
      const permissiveCalls = prisma.ticketType.findMany.mock.calls.filter(
        ([args]) => !(args as { select?: Record<string, boolean> }).select?.clientVisible,
      );
      expect(permissiveCalls).toHaveLength(0);
    });

    it('scopea por organización el proyecto, la política Y el tipo; solo contratos/políticas activos', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: incidencia }] as never);

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where).toMatchObject({
        projectId: PROJECT,
        isActive: true,
        project: { organizationId: ORG },
        slaPolicy: { organizationId: ORG, isActive: true },
        ticketType: { organizationId: ORG, isActive: true },
      });
      // sin filtro de criticidad no se agrega la clave
      expect(where.slaPolicy.criticality).toBeUndefined();
    });

    it('con criticidad filtra los contratos por la criticidad de la política (selector encadenado)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: incidencia }] as never);

      const result = await service.getAvailableTypes(ORG, PROJECT, {
        criticality: TicketCriticality.HIGH,
        audience: 'CLIENT',
      });

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.slaPolicy.criticality).toBe(TicketCriticality.HIGH);
      expect(result).toEqual({ types: [withRootAncestors(incidencia)], fallback: false });
    });
  });

  describe('getAvailableTypes — modo permisivo', () => {
    it('proyecto SIN contratos → todos los tipos activos de la org con fallback=true', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta, incidencia, mejora] });

      await expect(
        service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' }),
      ).resolves.toEqual({
        types: [consulta, incidencia, mejora].map(withRootAncestors),
        fallback: true,
      });
      expect(prisma.ticketType.findMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: ORG, isActive: true },
        orderBy: { name: 'asc' },
      });
    });

    it('criticidad que no matchea ningún contrato → permisivo (nunca un selector vacío)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta] });

      await expect(
        service.getAvailableTypes(ORG, PROJECT, {
          criticality: TicketCriticality.LOW,
          audience: 'CLIENT',
        }),
      ).resolves.toEqual({ types: [withRootAncestors(consulta)], fallback: true });
    });

    it('org sin ningún tipo activo → lista vacía marcada como fallback', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [] });

      await expect(
        service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' }),
      ).resolves.toEqual({ types: [], fallback: true });
    });
  });

  /**
   * #48 T3 — la audiencia.
   *
   * `clientVisible` va DENTRO del `where` de las DOS ramas. Los tests de abajo
   * miran el `where` real, no el resultado: es la única forma de distinguir
   * "filtró adentro" de "filtró después", y esa diferencia es justo la que
   * produce el bug del selector vacío.
   */
  describe('#48 T3 — audiencia', () => {
    it('CLIENT: filtra por clientVisible DENTRO del where de la rama de CONTRATOS', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: incidencia }] as never);

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.ticketType).toMatchObject({
        organizationId: ORG,
        isActive: true,
        clientVisible: true,
      });
    });

    it('CLIENT: filtra por clientVisible DENTRO del where de la rama PERMISIVA', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta] });

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      expect(prisma.ticketType.findMany.mock.calls[0][0]).toMatchObject({
        where: { organizationId: ORG, isActive: true, clientVisible: true },
      });
    });

    it('STAFF: NO filtra en ninguna de las dos ramas (el equipo ve las carpetas)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [incidencia] });

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'STAFF' });

      const contractWhere = (
        prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }
      ).where;
      expect(contractWhere.ticketType.clientVisible).toBeUndefined();
      const permissiveWhere = (prisma.ticketType.findMany.mock.calls[0][0] as { where: any }).where;
      expect(permissiveWhere.clientVisible).toBeUndefined();
    });

    /**
     * EL caso que obliga a filtrar adentro del where (#48 R2.4).
     *
     * Proyecto cuyos contratos apuntan TODOS a carpetas ocultas: con el filtro
     * adentro, la query de contratos vuelve vacía y el servicio cae al modo
     * permisivo. Filtrando después habría devuelto `{types: [], fallback: false}`
     * → el portal muestra un selector vacío y la UI cree que está configurado.
     */
    it('todos los contratos apuntan a carpetas ocultas → permisivo con fallback: true, NO un selector vacío', async () => {
      // El `where` con `clientVisible: true` no matchea ningún contrato.
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta, mejora] });

      const result = await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      expect(result.fallback).toBe(true);
      expect(result.types.map((t) => t.id)).toEqual([consulta.id, mejora.id]);
    });
  });

  /**
   * #48 T4 — ancestros resueltos server-side.
   *
   * No alcanzaba con mandar `parentId`: el front solo tiene los tipos OFRECIDOS,
   * y un padre oculto o sin contrato nunca viaja ahí, así que la cadena se
   * cortaba justo en el caso que importa.
   */
  describe('#48 T4 — ancestorNames', () => {
    /** Catálogo: Incidencia › Error del sistema. */
    const catalogoConPadre = (padreVisible: boolean) => [
      { id: 'type-inc', name: 'Incidencia', parentId: null, clientVisible: padreVisible },
      { id: 'type-err', name: 'Error del sistema', parentId: 'type-inc', clientVisible: true },
    ];

    it('padre VISIBLE → el cliente ve el prefijo', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: errorSistema },
      ] as never);
      mockTicketTypeQueries({ catalog: catalogoConPadre(true) });

      const { types } = await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      expect(types[0].ancestorNames).toEqual(['Incidencia']);
    });

    it('padre OCULTO → nombre pelado, sin el nombre de la carpeta (R3.1)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: errorSistema },
      ] as never);
      mockTicketTypeQueries({ catalog: catalogoConPadre(false) });

      const { types } = await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      expect(types[0]).toMatchObject({ name: 'Error del sistema', ancestorNames: [] });
    });

    it('padre oculto pero ABUELO visible → aporta solo el abuelo', async () => {
      const nieto = { id: 'type-nieto', name: 'Timeout', slug: 'timeout', parentId: 'type-err' };
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([{ ticketType: nieto }] as never);
      mockTicketTypeQueries({
        catalog: [
          { id: 'type-inc', name: 'Incidencia', parentId: null, clientVisible: true },
          { id: 'type-err', name: 'Error del sistema', parentId: 'type-inc', clientVisible: false },
          { id: 'type-nieto', name: 'Timeout', parentId: 'type-err', clientVisible: true },
        ],
      });

      const { types } = await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      expect(types[0].ancestorNames).toEqual(['Incidencia']);
    });

    it('STAFF ve la cadena COMPLETA aunque haya carpetas ocultas', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: errorSistema },
      ] as never);
      mockTicketTypeQueries({ catalog: catalogoConPadre(false) });

      const { types } = await service.getAvailableTypes(ORG, PROJECT, { audience: 'STAFF' });

      expect(types[0].ancestorNames).toEqual(['Incidencia']);
    });

    it('el catálogo de ancestros se consulta scopeado por organización', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: errorSistema },
      ] as never);
      mockTicketTypeQueries({ catalog: catalogoConPadre(true) });

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      const catalogCall = prisma.ticketType.findMany.mock.calls.find(
        ([args]) => (args as { select?: Record<string, boolean> }).select?.clientVisible,
      );
      expect(catalogCall?.[0]).toMatchObject({ where: { organizationId: ORG } });
    });

    it('sin tipos ofrecidos no se consulta el catálogo de ancestros', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [] });

      await service.getAvailableTypes(ORG, PROJECT, { audience: 'CLIENT' });

      const catalogCalls = prisma.ticketType.findMany.mock.calls.filter(
        ([args]) => (args as { select?: Record<string, boolean> }).select?.clientVisible,
      );
      expect(catalogCalls).toHaveLength(0);
    });
  });

  describe('isTypeAvailable — validación server-side de la creación desde el portal', () => {
    it('true si el tipo está contratado en el proyecto', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await expect(service.isTypeAvailable(ORG, PROJECT, incidencia.id)).resolves.toBe(true);
    });

    it('false si el proyecto tiene contratos y el tipo NO está entre ellos', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await expect(service.isTypeAvailable(ORG, PROJECT, consulta.id)).resolves.toBe(false);
    });

    it('true si el proyecto NO tiene contratos y el tipo existe/está activo en la org', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta, incidencia] });

      await expect(service.isTypeAvailable(ORG, PROJECT, consulta.id)).resolves.toBe(true);
    });

    it('modo permisivo NO relaja el scoping: un tipo de OTRA org sigue siendo inválido', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta] }); // catálogo de ESTA org

      await expect(service.isTypeAvailable(ORG, PROJECT, 'type-de-otra-org')).resolves.toBe(false);
    });

    it('valida SIN filtrar por criticidad (la disponibilidad es del par proyecto+tipo)', async () => {
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([
        { ticketType: incidencia },
      ] as never);

      await service.isTypeAvailable(ORG, PROJECT, incidencia.id);

      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.slaPolicy.criticality).toBeUndefined();
    });

    /**
     * El POST del portal valida con la MISMA audiencia con la que ofrece: si
     * divergieran, un cliente podría mandar a mano una carpeta oculta y el
     * backend se la aceptaría.
     */
    it('valida como CLIENTE: una carpeta oculta enviada a mano se rechaza', async () => {
      // Con `clientVisible: true` en el where, el contrato de la carpeta no vuelve.
      prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);
      mockTicketTypeQueries({ permissive: [consulta] });

      await expect(service.isTypeAvailable(ORG, PROJECT, 'type-carpeta-oculta')).resolves.toBe(
        false,
      );
      const where = (prisma.projectTicketTypeSla.findMany.mock.calls[0][0] as { where: any }).where;
      expect(where.ticketType.clientVisible).toBe(true);
    });
  });
});
