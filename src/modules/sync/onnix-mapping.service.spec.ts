import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Logger } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { OnnixMappingService } from './onnix-mapping.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { OnnixClientService } from './onnix-client.service';
import { OnnixCatalogos } from './types/onnix.types';
import {
  ONNIX_ENTITY_TYPE_TICKET_TYPE,
  ONNIX_TICKET_TYPE_SLUG_MAP,
} from './onnix-ticket-type-map';
import { ONNIX_SUPPORT_TEAM_ID } from './onnix-user-map';

// Cast puntual documentado: los getters de AppConfigService son read-only; el
// mock los hace asignables en runtime pero TS sigue viendo el tipo real.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/** Clave compuesta de `onnix_entity_mappings` (scoping multi-tenant). */
type MappingKey = { organizationId: string; entityType: string; zentikId: string };

/**
 * Tests de OnnixMappingService (features #13 y #50).
 *
 * Prisma MOCKEADO (jest-mock-extended) y OnnixClientService MOCKEADO (catalogos).
 * NUNCA toca DATABASE_URL ni HTTP real.
 *
 * Cubre: T19 (R15/R16/R17/R18 mapeo cliente y proyecto), + R19/R20/R21 (#13) y
 * #50 T1 (cascada nodo → padre → default, R1.1/R1.5) + T2 (seed por slug idempotente,
 * R1.3/R1.4).
 */
describe('OnnixMappingService', () => {
  let service: OnnixMappingService;
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  let onnix: DeepMockProxy<OnnixClientService>;
  // El service loggea por Logger de Nest; se espia en el prototipo para poder
  // asertar los warn del default/desalineaciones sin ensuciar la salida de jest.
  let warnSpy: jest.SpyInstance;

  const TRACE = 'trace-1';
  const ORG = 'org-test';

  const catalogos: OnnixCatalogos = {
    estados: [
      { id: 1, name: 'Nuevo', slug: 'nuevo' },
      { id: 2, name: 'En proceso', slug: 'en_proceso' },
      { id: 3, name: 'Resuelto', slug: 'resuelto' },
    ],
    tipos: [{ id: 10, name: 'Soporte', slug: 'soporte' }],
    categorias: [{ id: 20, name: 'General', slug: 'general' }],
    prioridades: [{ id: 30, name: 'Media', slug: 'media' }],
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    onnix = mockDeep<OnnixClientService>();
    config.onnixCatalogCacheTtlSec = 600;
    // Whitelist = scope del seed (#50 D3). mockDeep auto-stubearia el getter a una
    // funcion (no iterable) -> se fija explicito.
    config.onnixSyncOrgIds = [ORG];
    onnix.getCatalogos.mockResolvedValue(catalogos);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    service = new OnnixMappingService(prisma, config, onnix);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Stub del lookup de mappings: tabla en memoria `entityType|zentikId -> onnixId`.
   * Reproduce el `findUnique` real (clave compuesta scoped por org) sin ordenar
   * `mockResolvedValueOnce`, que en la cascada de #50 depende del camino tomado.
   */
  function stubMappings(rows: Record<string, number>): void {
    prisma.onnixEntityMapping.findUnique.mockImplementation(((args: {
      where: { organizationId_entityType_zentikId: MappingKey };
    }) => {
      const key = args.where.organizationId_entityType_zentikId;
      const onnixId = rows[`${key.entityType}|${key.zentikId}`];
      return Promise.resolve(onnixId === undefined ? null : { onnixId });
    }) as never);
  }

  /** zentikIds consultados contra `entityType: 'ticket_type'`, en orden. */
  function ticketTypeLookups(): string[] {
    return prisma.onnixEntityMapping.findUnique.mock.calls
      .map((c) => c[0].where.organizationId_entityType_zentikId as MappingKey | undefined)
      .filter((k): k is MappingKey => k !== undefined)
      .filter((k) => k.entityType === ONNIX_ENTITY_TYPE_TICKET_TYPE)
      .map((k) => k.zentikId);
  }

  describe('resolveClientId — R15/R16 (scoped por org)', () => {
    it('R15: cliente mapeado -> devuelve el onnix_id de la tabla de mapeo', async () => {
      // Partial: el service solo selecciona onnixId; cast porque Prisma tipa el modelo completo.
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce({ onnixId: 555 } as never);
      const id = await service.resolveClientId(ORG, 'zentik_client_1');
      expect(id).toBe(555);
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'client',
          zentikId: 'zentik_client_1',
        },
      });
    });

    it('R16: cliente NO mapeado -> null (la fila ira a failed en el dispatcher)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce(null);
      const id = await service.resolveClientId(ORG, 'zentik_client_desconocido');
      expect(id).toBeNull();
    });
  });

  describe('resolveProjectId — R17/R18 (scoped por org)', () => {
    it('R17: proyecto mapeado -> devuelve el project_id de Onnix', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce({ onnixId: 777 } as never);
      const id = await service.resolveProjectId(ORG, 'zentik_project_1');
      expect(id).toBe(777);
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'project',
          zentikId: 'zentik_project_1',
        },
      });
    });

    it('R18: proyecto NO mapeado -> null (best-effort, no bloquea, no failed)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce(null);
      const id = await service.resolveProjectId(ORG, 'zentik_project_x');
      expect(id).toBeNull();
    });

    it('R18: proyecto null/undefined -> null sin tocar la DB', async () => {
      const id = await service.resolveProjectId(ORG, null);
      expect(id).toBeNull();
      expect(prisma.onnixEntityMapping.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('resolveStatusSlug — R21', () => {
    it('R21: estado Zentik -> slug Onnix validado contra el catalogo', async () => {
      const slug = await service.resolveStatusSlug(TicketStatus.IN_PROGRESS, TRACE);
      expect(slug).toBe('en_proceso');
      expect(catalogos.estados.some((e) => e.slug === slug)).toBe(true);
    });

    it('mapea OPEN -> nuevo y RESOLVED -> resuelto', async () => {
      expect(await service.resolveStatusSlug(TicketStatus.OPEN, TRACE)).toBe('nuevo');
      expect(await service.resolveStatusSlug(TicketStatus.RESOLVED, TRACE)).toBe('resuelto');
    });
  });

  describe('resolveCatalogIds — R19 (scoped por org)', () => {
    it('R19: usa mapeo explicito de tipo/categoria/prioridad si existe', async () => {
      prisma.onnixEntityMapping.findUnique
        .mockResolvedValueOnce({ onnixId: 11 } as never) // ticket_type
        .mockResolvedValueOnce({ onnixId: 22 } as never) // ticket_category
        .mockResolvedValueOnce({ onnixId: 33 } as never); // ticket_priority
      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      expect(ids).toEqual({ ticketTypeId: 11, ticketCategoryId: 22, ticketPriorityId: 33 });
      // El lookup del catalogo tambien va scoped por org (clave compuesta).
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: 'ticket_type',
          zentikId: 'SUPPORT_REQUEST',
        },
      });
    });

    it('R19: sin mapeo -> fallback al primer item del catalogo (default + warn)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValue(null);
      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      expect(ids).toEqual({ ticketTypeId: 10, ticketCategoryId: 20, ticketPriorityId: 30 });
    });
  });

  describe('cache de catalogos — R20', () => {
    it('R20: sirve catalogos desde cache (no llama getCatalogos por cada resolucion)', async () => {
      prisma.onnixEntityMapping.findUnique.mockResolvedValue(null);
      await service.resolveStatusSlug(TicketStatus.OPEN, TRACE);
      await service.resolveStatusSlug(TicketStatus.RESOLVED, TRACE);
      await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE);
      // Multiples resoluciones -> una sola llamada HTTP a catalogos (TTL vigente).
      expect(onnix.getCatalogos).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #50 T1 — Tipo de incidencia REAL: cascada nodo → padre → default (R1.1/R1.5)
  // ───────────────────────────────────────────────────────────────────────────
  describe('resolveCatalogIds — cascada de ticket_type (#50 T1 / R1.1)', () => {
    const CHILD = 'tt_child_cuid';
    const PARENT = 'tt_parent_cuid';

    it('R1.1 paso 1: mapping del NODO exacto -> ese onnixId, sin consultar al padre', async () => {
      stubMappings({ [`${ONNIX_ENTITY_TYPE_TICKET_TYPE}|${CHILD}`]: 18 });

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      expect(ids.ticketTypeId).toBe(18);
      // Hit en el nodo -> ni se lee el arbol ni se cae al default por enum.
      expect(prisma.ticketType.findUnique).not.toHaveBeenCalled();
      expect(ticketTypeLookups()).toEqual([CHILD]);
    });

    it('R1.1 paso 2: nodo sin mapping pero PADRE mapeado -> onnixId del padre (lee parentId del arbol)', async () => {
      stubMappings({ [`${ONNIX_ENTITY_TYPE_TICKET_TYPE}|${PARENT}`]: 21 });
      prisma.ticketType.findUnique.mockResolvedValue({ parentId: PARENT } as never);

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      expect(ids.ticketTypeId).toBe(21);
      // La red para tipos nuevos dentro de una rama: un solo salto al padre.
      expect(prisma.ticketType.findUnique).toHaveBeenCalledWith({
        where: { id: CHILD },
        select: { parentId: true },
      });
      expect(ticketTypeLookups()).toEqual([CHILD, PARENT]);
    });

    it('R1.1 paso 3: nodo sin mapping y padre sin mapping -> default de hoy (catalogo[0] + warn)', async () => {
      stubMappings({}); // ni nodo, ni padre, ni el enum: nada mapeado.
      prisma.ticketType.findUnique.mockResolvedValue({ parentId: PARENT } as never);

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      // catalogos.tipos[0].id = 10 -> el comportamiento de #13 queda intacto.
      expect(ids.ticketTypeId).toBe(10);
      // El ultimo lookup es el del ENUM: espacios de ids disjuntos (cuid vs enum).
      expect(ticketTypeLookups()).toEqual([CHILD, PARENT, 'SUPPORT_REQUEST']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Sin mapeo ${ONNIX_ENTITY_TYPE_TICKET_TYPE} para 'SUPPORT_REQUEST'`),
      );
    });

    it('R1.1 paso 3: nodo raiz (sin parentId) y sin mapping -> default, sin lookup de padre', async () => {
      stubMappings({});
      prisma.ticketType.findUnique.mockResolvedValue({ parentId: null } as never);

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      expect(ids.ticketTypeId).toBe(10);
      expect(ticketTypeLookups()).toEqual([CHILD, 'SUPPORT_REQUEST']);
    });

    it('R1.5: ticket SIN ticketTypeId (null) -> default directo, sin tocar el arbol, nunca falla', async () => {
      stubMappings({});

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, null);

      expect(ids).toEqual({ ticketTypeId: 10, ticketCategoryId: 20, ticketPriorityId: 30 });
      // Historico/edge: ni una query al arbol, ni un throw.
      expect(prisma.ticketType.findUnique).not.toHaveBeenCalled();
      expect(ticketTypeLookups()).toEqual(['SUPPORT_REQUEST']);
    });

    it('R1.5: ticket con tipo pero borrado del arbol (findUnique null) -> default, sin romper', async () => {
      stubMappings({});
      prisma.ticketType.findUnique.mockResolvedValue(null);

      const ids = await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      expect(ids.ticketTypeId).toBe(10);
      expect(ticketTypeLookups()).toEqual([CHILD, 'SUPPORT_REQUEST']);
    });

    it('la cascada va scoped por org (clave compuesta), igual que el resto de los lookups', async () => {
      stubMappings({ [`${ONNIX_ENTITY_TYPE_TICKET_TYPE}|${CHILD}`]: 18 });

      await service.resolveCatalogIds(ORG, 'SUPPORT_REQUEST', 'MEDIUM', TRACE, CHILD);

      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: ORG,
          entityType: ONNIX_ENTITY_TYPE_TICKET_TYPE,
          zentikId: CHILD,
        },
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // #50 T2 — Seed de mappings por slug (R1.3 / R1.4)
  // ───────────────────────────────────────────────────────────────────────────
  describe('seedTicketTypeMappings — seed por slug (#50 T2 / R1.3-R1.4)', () => {
    /** Todos los slugs de la tabla R1.4 como TicketType de la org. */
    const allTypes = Object.keys(ONNIX_TICKET_TYPE_SLUG_MAP).map((slug) => ({
      id: `tt_${slug}`,
      slug,
    }));

    const keyOf = (zentikId: string) =>
      `${ORG}|${ONNIX_ENTITY_TYPE_TICKET_TYPE}|${zentikId}`;

    /**
     * DB en memoria de `onnix_entity_mappings`: el `upsert` escribe y el `findMany`
     * lee lo escrito. Sin esto la idempotencia no se puede testear de verdad (la
     * 2a corrida tiene que VER lo que dejo la 1a).
     */
    function fakeMappingStore(): Map<string, number> {
      const store = new Map<string, number>();
      prisma.onnixEntityMapping.findMany.mockImplementation(((args: {
        where: { organizationId: string; entityType: string; zentikId: { in: string[] } };
      }) => {
        const { organizationId, entityType, zentikId } = args.where;
        const rows = zentikId.in
          .map((id) => ({ zentikId: id, onnixId: store.get(`${organizationId}|${entityType}|${id}`) }))
          .filter((r): r is { zentikId: string; onnixId: number } => r.onnixId !== undefined);
        return Promise.resolve(rows);
      }) as never);
      prisma.onnixEntityMapping.upsert.mockImplementation(((args: {
        where: { organizationId_entityType_zentikId: MappingKey };
        update: { onnixId: number };
      }) => {
        const key = args.where.organizationId_entityType_zentikId;
        store.set(`${key.organizationId}|${key.entityType}|${key.zentikId}`, args.update.onnixId);
        return Promise.resolve({});
      }) as never);
      return store;
    }

    it('R1.4: la tabla es DATO CONFIRMADO del catalogo de OSD — 12 pares exactos', () => {
      // Guard anti-"correccion": cualquier fila agregada, sacada o retocada rompe
      // aca antes de mandar tickets al tipo equivocado. Los ids no son correlativos
      // a proposito (falta el 23, salta al 94).
      expect(ONNIX_TICKET_TYPE_SLUG_MAP).toEqual({
        'fallo-total-en-flujos-o-canales': 15,
        'error-en-colas-y-derivaciones': 16,
        'problemas-de-integracion-whatsapp-web': 17,
        'nuevo-desarrollo': 18,
        'cambio-de-textos-o-mensajes-speech': 19,
        'actualizacion-de-datos-ciudades-asesores': 20,
        'dudas-y-consultas-de-uso-general': 21,
        'capacitacion-sobre-la-plataforma': 22,
        'flujo-o-formulario-especifico-con-error': 24,
        'fallo-en-logica-de-asignacion-asesor': 25,
        'errores-en-notificaciones-y-alertas': 26,
        'solicitud-de-creacion-de-usuario': 94,
      });
      expect(Object.keys(ONNIX_TICKET_TYPE_SLUG_MAP)).toHaveLength(12);
    });

    it('R1.4: siembra los 12 pares con los onnixId exactos (15,16,17,18,19,20,21,22,24,25,26,94)', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue(allTypes as never);

      const [res] = await service.seedTicketTypeMappings();

      expect(res.organizationId).toBe(ORG);
      expect(res.created).toBe(12);
      expect(res.updated).toBe(0);
      expect(res.alreadyMapped).toBe(0);
      expect(res.zentikSlugsWithoutPair).toEqual([]);
      expect(res.tableSlugsWithoutTicketType).toEqual([]);

      // Estado final fila por fila: clave compuesta (org, 'ticket_type', TicketType.id).
      expect([...store.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toEqual(
        Object.entries(ONNIX_TICKET_TYPE_SLUG_MAP)
          .map(([slug, onnixId]): [string, number] => [keyOf(`tt_${slug}`), onnixId])
          .sort((a, b) => a[0].localeCompare(b[0])),
      );
      expect([...store.values()].sort((a, b) => a - b)).toEqual([
        15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 94,
      ]);
      // Spot-check de los dos bordes de la tabla (el primero y el salto a 94).
      expect(store.get(keyOf('tt_fallo-total-en-flujos-o-canales'))).toBe(15);
      expect(store.get(keyOf('tt_solicitud-de-creacion-de-usuario'))).toBe(94);
    });

    it('R1.3: idempotente — 2 corridas seguidas dejan el MISMO estado y la 2a no reescribe', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue(allTypes as never);

      const [first] = await service.seedTicketTypeMappings();
      const snapshot = [...store.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      expect(first.created).toBe(12);
      expect(prisma.onnixEntityMapping.upsert).toHaveBeenCalledTimes(12);

      const [second] = await service.seedTicketTypeMappings();

      // Mismo estado, sin duplicar filas (la clave compuesta es la misma).
      expect([...store.entries()].sort((a, b) => a[0].localeCompare(b[0]))).toEqual(snapshot);
      expect(store.size).toBe(12);
      // Y sin escrituras inutiles: el service compara contra el estado previo y
      // saltea las filas ya iguales (`alreadyMapped`), no re-upsertea 12 veces.
      expect(second).toEqual({
        organizationId: ORG,
        created: 0,
        updated: 0,
        alreadyMapped: 12,
        zentikSlugsWithoutPair: [],
        tableSlugsWithoutTicketType: [],
      });
      expect(prisma.onnixEntityMapping.upsert).toHaveBeenCalledTimes(12);
    });

    it('R1.3: mapping viejo con otro onnixId -> se corrige (updated), la tabla es la fuente de verdad', async () => {
      const store = fakeMappingStore();
      store.set(keyOf('tt_nuevo-desarrollo'), 999); // valor cargado a mano, desalineado.
      prisma.ticketType.findMany.mockResolvedValue([{ id: 'tt_nuevo-desarrollo', slug: 'nuevo-desarrollo' }] as never);

      const [res] = await service.seedTicketTypeMappings();

      expect(res.created).toBe(0);
      expect(res.updated).toBe(1);
      expect(store.get(keyOf('tt_nuevo-desarrollo'))).toBe(18);
    });

    it('R1.3: slug de la tabla SIN TicketType en la org -> se reporta, NO tira error', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue(
        [
          { id: 'tt_nuevo-desarrollo', slug: 'nuevo-desarrollo' },
          { id: 'tt_capacitacion-sobre-la-plataforma', slug: 'capacitacion-sobre-la-plataforma' },
        ] as never,
      );

      const [res] = await service.seedTicketTypeMappings();

      expect(res.created).toBe(2);
      expect(store.size).toBe(2);
      // Los 10 restantes de la tabla se reportan ordenados (senal de arbol incompleto).
      expect(res.tableSlugsWithoutTicketType).toEqual(
        Object.keys(ONNIX_TICKET_TYPE_SLUG_MAP)
          .filter((s) => s !== 'nuevo-desarrollo' && s !== 'capacitacion-sobre-la-plataforma')
          .sort(),
      );
      expect(res.zentikSlugsWithoutPair).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('slug(s) de la tabla R1.4 sin TicketType en esta org'),
      );
    });

    it('R1.3: TicketType de Zentik cuyo slug NO esta en la tabla -> se loggea "sin par", NO tira error', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue(
        [
          { id: 'tt_nuevo-desarrollo', slug: 'nuevo-desarrollo' },
          { id: 'tt_x', slug: 'carpeta-oculta-del-dueno' },
          { id: 'tt_y', slug: 'algo-que-inventaron-despues' },
        ] as never,
      );

      const [res] = await service.seedTicketTypeMappings();

      // Los sin par NO se siembran (nada que inventar): caen al default en runtime.
      expect(res.created).toBe(1);
      expect(store.size).toBe(1);
      expect(store.get(keyOf('tt_nuevo-desarrollo'))).toBe(18);
      expect(res.zentikSlugsWithoutPair).toEqual([
        'algo-que-inventaron-despues',
        'carpeta-oculta-del-dueno',
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('slug(s) de Zentik sin par en la tabla R1.4'),
      );
    });

    it('D3: el mismo slug en dos ramas -> ambos nodos reciben el mismo onnixId (correcto por diseno)', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue(
        [
          { id: 'tt_rama_a', slug: 'errores-en-notificaciones-y-alertas' },
          { id: 'tt_rama_b', slug: 'errores-en-notificaciones-y-alertas' },
        ] as never,
      );

      const [res] = await service.seedTicketTypeMappings();

      expect(res.created).toBe(2);
      expect(store.get(keyOf('tt_rama_a'))).toBe(26);
      expect(store.get(keyOf('tt_rama_b'))).toBe(26);
      expect(res.zentikSlugsWithoutPair).toEqual([]);
    });

    it('org sin ningun TicketType -> resultado vacio sin escrituras ni error', async () => {
      const store = fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue([] as never);

      const [res] = await service.seedTicketTypeMappings();

      expect(res.created + res.updated + res.alreadyMapped).toBe(0);
      expect(store.size).toBe(0);
      expect(prisma.onnixEntityMapping.upsert).not.toHaveBeenCalled();
      // Sin targets no se consulta el estado previo (query evitada).
      expect(prisma.onnixEntityMapping.findMany).not.toHaveBeenCalled();
      expect(res.tableSlugsWithoutTicketType).toHaveLength(12);
    });

    it('el scope es la whitelist ONNIX_SYNC_ORG_IDS: un resultado por org, vacia -> nada', async () => {
      fakeMappingStore();
      prisma.ticketType.findMany.mockResolvedValue([] as never);

      config.onnixSyncOrgIds = ['org-a', 'org-b'];
      const many = await service.seedTicketTypeMappings();
      expect(many.map((r) => r.organizationId)).toEqual(['org-a', 'org-b']);

      config.onnixSyncOrgIds = [];
      expect(await service.seedTicketTypeMappings()).toEqual([]);
    });
  });

  // ── #52 T2 — seed de usuarios por email ────────────────────────────────────

  describe('seedUserMappings — #52 T2 (R1.2/R1.3)', () => {
    /**
     * Misma tabla en memoria que el seed de tipos, pero para `entityType: 'user'`.
     * Permite verificar la idempotencia real (2ª corrida = todo alreadyMapped, cero
     * escrituras) en vez de solo contar llamadas.
     */
    function fakeUserStore(): Map<string, number> {
      const store = new Map<string, number>();
      prisma.onnixEntityMapping.findMany.mockImplementation(((args: {
        where: { organizationId: string; entityType: string; zentikId: { in: string[] } };
      }) => {
        const { organizationId, entityType, zentikId } = args.where;
        const rows = zentikId.in
          .map((id) => ({ zentikId: id, onnixId: store.get(`${organizationId}|${entityType}|${id}`) }))
          .filter((r): r is { zentikId: string; onnixId: number } => r.onnixId !== undefined);
        return Promise.resolve(rows);
      }) as never);
      prisma.onnixEntityMapping.upsert.mockImplementation(((args: {
        where: { organizationId_entityType_zentikId: MappingKey };
        update: { onnixId: number };
      }) => {
        const key = args.where.organizationId_entityType_zentikId;
        store.set(`${key.organizationId}|${key.entityType}|${key.zentikId}`, args.update.onnixId);
        return Promise.resolve({});
      }) as never);
      return store;
    }

    function stubUsers(users: { id: string; email: string; name: string }[]): void {
      prisma.user.findMany.mockResolvedValue(users as never);
    }

    it('R1.2: matchea por EMAIL y crea el mapping user -> onnixId', async () => {
      // La verificacion del dueño (R0.2) encontro que los NOMBRES no coinciden entre
      // los dos sistemas ("Ada Luisa Mereles Patiño" vs "Ada Mereles"). Matchear por
      // nombre habria fallado en produccion: por eso el par es el email.
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 10, name: 'Ada Luisa Mereles Patiño', email: 'amereles@onnix.com.py', is_active: true },
      ]);
      stubUsers([{ id: 'u_ada', email: 'amereles@onnix.com.py', name: 'Ada Mereles' }]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(1);
      expect(store.get(`${ORG}|user|u_ada`)).toBe(10);
      expect(res.zentikUsersWithoutPair).toEqual([]);
      expect(res.onnixMembersWithoutPair).toEqual([]);
    });

    it('R1.2: el match es case-insensitive y con trim (una mayuscula no puede dejar a alguien sin mapear)', async () => {
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 14, name: 'Josue Farias', email: '  CFarias@Onnix.Com.Py ', is_active: true },
      ]);
      stubUsers([{ id: 'u_josue', email: 'cfarias@onnix.com.py', name: 'Josue' }]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(1);
      expect(store.get(`${ORG}|user|u_josue`)).toBe(14);
    });

    it('R1.2: `is_active: false` en OSD NO se mapea — asignarle un ticket seria el 422 que esto viene a evitar', async () => {
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 99, name: 'Ex Empleado', email: 'ex@onnix.com.py', is_active: false },
      ]);
      stubUsers([{ id: 'u_ex', email: 'ex@onnix.com.py', name: 'Ex Empleado' }]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(0);
      expect(store.size).toBe(0);
      expect(res.inactiveSkipped).toEqual(['Ex Empleado <ex@onnix.com.py> (osdId=99)']);
      // El usuario de Zentik queda reportado como sin par: su asignacion NO va a viajar.
      expect(res.zentikUsersWithoutPair).toEqual(['Ex Empleado <ex@onnix.com.py>']);
    });

    it('GUARD: `is_active` AUSENTE cuenta como activo (un campo opcional no puede dejar al equipo sin mapear)', async () => {
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 11, name: 'Milena Ojeda', email: 'amojeda@onnix.com.py' },
      ]);
      stubUsers([{ id: 'u_mile', email: 'amojeda@onnix.com.py', name: 'Milena' }]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(1);
      expect(store.get(`${ORG}|user|u_mile`)).toBe(11);
    });

    it('⚠️ R1.3: los sin par de LOS DOS LADOS se reportan CON NOMBRE Y EMAIL, no como un contador', async () => {
      // Es la unica señal que va a delatar al proximo usuario que se sume a Zentik y
      // que nadie de de alta en el equipo de OSD. Un "2 sin par" no se puede
      // accionar; "Fulano <f@onnix.com.py>" si.
      fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 10, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
        { id: 77, name: 'Alguien de OSD', email: 'otro@onnix.com.py', is_active: true },
      ]);
      stubUsers([
        { id: 'u_ada', email: 'amereles@onnix.com.py', name: 'Ada Mereles' },
        { id: 'u_nuevo', email: 'nuevo@onnix.com.py', name: 'Dev Nuevo' },
      ]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(1);
      expect(res.zentikUsersWithoutPair).toEqual(['Dev Nuevo <nuevo@onnix.com.py>']);
      expect(res.onnixMembersWithoutPair).toEqual([
        'Alguien de OSD <otro@onnix.com.py> (osdId=77)',
      ]);
      // Y ademas sale por warn, para el que mira los logs y no el body del endpoint.
      const warns = warnSpy.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(warns).toContain('nuevo@onnix.com.py');
      expect(warns).toContain('otro@onnix.com.py');
    });

    it('R1.2: IDEMPOTENCIA — la 2ª corrida no escribe NADA (todo alreadyMapped)', async () => {
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 10, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
      ]);
      stubUsers([{ id: 'u_ada', email: 'amereles@onnix.com.py', name: 'Ada Mereles' }]);

      const [first] = await service.seedUserMappings();
      expect(first.created).toBe(1);

      prisma.onnixEntityMapping.upsert.mockClear();
      const [second] = await service.seedUserMappings();

      expect(second).toMatchObject({ created: 0, updated: 0, alreadyMapped: 1 });
      // Idempotencia REAL: no toca la fila, no "escribe lo mismo".
      expect(prisma.onnixEntityMapping.upsert).not.toHaveBeenCalled();
      expect(store.get(`${ORG}|user|u_ada`)).toBe(10);
    });

    it('R1.2: si el id de OSD CAMBIA, la 2ª corrida actualiza (updated, no created)', async () => {
      const store = fakeUserStore();
      onnix.getTeamMembers.mockResolvedValueOnce([
        { id: 10, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
      ]);
      stubUsers([{ id: 'u_ada', email: 'amereles@onnix.com.py', name: 'Ada Mereles' }]);
      await service.seedUserMappings();

      onnix.getTeamMembers.mockResolvedValueOnce([
        { id: 42, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
      ]);
      const [second] = await service.seedUserMappings();

      expect(second).toMatchObject({ created: 0, updated: 1, alreadyMapped: 0 });
      expect(store.get(`${ORG}|user|u_ada`)).toBe(42);
    });

    it('solo usuarios INTERNOS de la org: el `where` exige clientId null + membresia', async () => {
      // Un usuario cliente jamas es responsable de un ticket en OSD; mapearlo solo
      // agregaria una forma de asignar mal.
      fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([]);
      stubUsers([]);

      await service.seedUserMappings();

      expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          clientId: null,
          organizationMembers: { some: { organizationId: ORG } },
        },
      });
    });

    it('usa el equipo ONNIX_SUPPORT_TEAM_ID y pide los miembros UNA sola vez para todas las orgs', async () => {
      fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([]);
      stubUsers([]);
      config.onnixSyncOrgIds = ['org-a', 'org-b'];

      const many = await service.seedUserMappings();

      expect(many.map((r) => r.organizationId)).toEqual(['org-a', 'org-b']);
      expect(onnix.getTeamMembers).toHaveBeenCalledTimes(1);
      expect(onnix.getTeamMembers).toHaveBeenCalledWith(ONNIX_SUPPORT_TEAM_ID, expect.any(String));
    });

    it('miembro de OSD SIN email -> no matchea a nadie y queda reportado, sin romper el seed', async () => {
      fakeUserStore();
      onnix.getTeamMembers.mockResolvedValue([
        { id: 88, name: 'Sin Email', is_active: true },
        { id: 10, name: 'Ada', email: 'amereles@onnix.com.py', is_active: true },
      ]);
      stubUsers([{ id: 'u_ada', email: 'amereles@onnix.com.py', name: 'Ada Mereles' }]);

      const [res] = await service.seedUserMappings();

      expect(res.created).toBe(1);
      expect(res.onnixMembersWithoutPair).toEqual(['Sin Email <sin email> (osdId=88)']);
    });

    it('R0.1: el equipo de soporte es una CONSTANTE en codigo, no una env var', () => {
      // Criterio de #46: no cambia por entorno -> una variable solo agregaria una
      // forma de que prod y local difieran sin que nadie se entere.
      expect(ONNIX_SUPPORT_TEAM_ID).toBe(2);
    });
  });
});
