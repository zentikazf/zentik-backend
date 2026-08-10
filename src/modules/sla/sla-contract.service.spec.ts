import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { SlaContractService } from './sla-contract.service';

/**
 * Tests de `SlaContractService.upsertForProject` (#48 T1) y de la jerarquía que
 * viaja en la matriz (#48 T1b).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * Lo que custodian:
 *
 *  1. **Descontratar desactiva DE VERDAD.** El hallazgo R0 del spec: hasta acá el
 *     upsert solo sabía crear y actualizar. Una fila con `isActive: false` tiene
 *     que apagar el contrato, y hacerlo SIN exigir política (descontratar no
 *     tiene por qué saber con qué se atendía).
 *
 *  2. **Lo omitido queda INTACTO.** Es la semántica real del endpoint, y estuvo
 *     documentada al revés en el frontend durante toda #42. Se fija con un test
 *     para que deje de ser folklore: si alguien la cambia, esto se rompe.
 *
 * El centro de contratación se apoya en las dos: manda solo lo que el usuario
 * tocó y apaga explícitamente lo que destildó.
 */
describe('SlaContractService — upsertForProject (#48 T1)', () => {
  let service: SlaContractService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  const ORG = 'org-1';
  const PROJECT = 'project-1';
  const USER = 'user-1';

  const padre = {
    id: 'type-inc',
    name: 'Incidencia',
    slug: 'incidencia',
    parentId: null,
    path: 'incidencia',
    level: 0,
    // Carpeta pura: el padre no se le ofrece al cliente, pero sus hijos sí.
    clientVisible: false,
  };
  const hijo = {
    id: 'type-err',
    name: 'Error del sistema',
    slug: 'error-del-sistema',
    parentId: 'type-inc',
    path: 'incidencia/error-del-sistema',
    level: 1,
    clientVisible: true,
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    service = new SlaContractService(prisma, eventEmitter);

    // Camino feliz de las validaciones previas a la tx.
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT,
      name: 'Proyecto Demo',
      slaPolicyId: null,
    } as never);
    // "todo lo que pediste existe": devolvemos tantas filas como ids se
    // consultaron, que es lo que el service compara para decidir el 404.
    const countAsAllFound = (args: unknown) =>
      Promise.resolve(((args as { where: { id: { in: string[] } } }).where.id.in ?? []).length);
    prisma.ticketType.count.mockImplementation(countAsAllFound as never);
    prisma.slaPolicy.count.mockImplementation(countAsAllFound as never);
    // `upsertForProject` cierra devolviendo `getByProject`.
    prisma.ticketType.findMany.mockResolvedValue([] as never);
    prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  describe('descontratar (isActive: false)', () => {
    it('desactiva la fila SIN exigir política (antes era un SLA_POLICY_NOT_FOUND latente)', async () => {
      await service.upsertForProject(
        ORG,
        PROJECT,
        { items: [{ ticketTypeId: hijo.id, isActive: false }] },
        USER,
      );

      expect(lastTx.projectTicketTypeSla.updateMany).toHaveBeenCalledTimes(1);
      expect(lastTx.projectTicketTypeSla.updateMany.mock.calls[0][0]).toEqual({
        where: { projectId: PROJECT, ticketTypeId: hijo.id },
        data: { isActive: false },
      });
      // NO se hace un upsert: crear una fila apagada sin política es imposible
      // (`sla_policy_id` es NOT NULL) y no significaría nada.
      expect(lastTx.projectTicketTypeSla.upsert).not.toHaveBeenCalled();
    });

    it('no valida la política de una fila que solo apaga (no hay ninguna que validar)', async () => {
      await service.upsertForProject(
        ORG,
        PROJECT,
        { items: [{ ticketTypeId: hijo.id, isActive: false }] },
        USER,
      );

      expect(prisma.slaPolicy.count).not.toHaveBeenCalled();
    });

    it('descontratar un tipo que nunca tuvo contrato es un no-op, no un error', async () => {
      // `updateMany` sobre cero filas: no lanza. Ese es justo el punto de usarlo
      // en vez de `update`.
      lastTx = undefined as never;
      await expect(
        service.upsertForProject(
          ORG,
          PROJECT,
          { items: [{ ticketTypeId: 'type-sin-contrato', isActive: false }] },
          USER,
        ),
      ).resolves.toBeDefined();
    });

    it('ignora la política que venga en una fila que apaga: no reescribe la historia del contrato', async () => {
      // El editor viejo (`project-sla-section`) manda la política vigente junto
      // con `isActive: false`. Se sigue aceptando, pero no se escribe.
      await service.upsertForProject(
        ORG,
        PROJECT,
        { items: [{ ticketTypeId: hijo.id, slaPolicyId: 'policy-1', isActive: false }] },
        USER,
      );

      expect(lastTx.projectTicketTypeSla.updateMany.mock.calls[0][0]).toEqual({
        where: { projectId: PROJECT, ticketTypeId: hijo.id },
        data: { isActive: false },
      });
    });

    it('mezcla: contrata unos y descontrata otros en la MISMA transacción', async () => {
      await service.upsertForProject(
        ORG,
        PROJECT,
        {
          items: [
            { ticketTypeId: hijo.id, slaPolicyId: 'policy-1', isActive: true },
            { ticketTypeId: padre.id, isActive: false },
          ],
        },
        USER,
      );

      expect(lastTx.projectTicketTypeSla.upsert).toHaveBeenCalledTimes(1);
      expect(lastTx.projectTicketTypeSla.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Solo la política de la fila CONTRATADA se valida.
      expect(prisma.slaPolicy.count.mock.calls[0][0]).toMatchObject({
        where: { id: { in: ['policy-1'] }, organizationId: ORG, isActive: true },
      });
    });
  });

  describe('semántica del endpoint: lo omitido NO se toca', () => {
    it('un tipo que no viaja en items no genera NINGUNA escritura', async () => {
      await service.upsertForProject(
        ORG,
        PROJECT,
        { items: [{ ticketTypeId: hijo.id, slaPolicyId: 'policy-1' }] },
        USER,
      );

      // Ni un deleteMany, ni un updateMany masivo: el endpoint es un upsert de
      // las filas recibidas, no un reemplazo de la matriz. Descontratar es
      // EXPLÍCITO (ver el describe de arriba).
      expect(lastTx.projectTicketTypeSla.deleteMany).not.toHaveBeenCalled();
      expect(lastTx.projectTicketTypeSla.updateMany).not.toHaveBeenCalled();
      expect(lastTx.projectTicketTypeSla.upsert).toHaveBeenCalledTimes(1);
      expect(lastTx.projectTicketTypeSla.upsert.mock.calls[0][0]).toMatchObject({
        where: { projectId_ticketTypeId: { projectId: PROJECT, ticketTypeId: hijo.id } },
        create: { ticketTypeId: hijo.id, slaPolicyId: 'policy-1', isActive: true },
        update: { slaPolicyId: 'policy-1', isActive: true },
      });
    });

    it('items vacío no escribe nada', async () => {
      await service.upsertForProject(ORG, PROJECT, { items: [] }, USER);

      expect(lastTx.projectTicketTypeSla.upsert).not.toHaveBeenCalled();
      expect(lastTx.projectTicketTypeSla.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('validaciones', () => {
    it('una fila ACTIVA sin política es 422 (defensa por si el DTO no corrió)', async () => {
      await expect(
        service.upsertForProject(
          ORG,
          PROJECT,
          { items: [{ ticketTypeId: hijo.id }] },
          USER,
        ),
      ).rejects.toMatchObject({ code: 'SLA_POLICY_REQUIRED', statusCode: 422 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un tipo de OTRA organización es 404 también cuando solo se lo quiere apagar', async () => {
      prisma.ticketType.count.mockResolvedValue(0 as never);

      await expect(
        service.upsertForProject(
          ORG,
          PROJECT,
          { items: [{ ticketTypeId: 'type-de-otra-org', isActive: false }] },
          USER,
        ),
      ).rejects.toMatchObject({ code: 'TICKET_TYPE_NOT_FOUND', statusCode: 404 });
    });

    it('el mismo tipo dos veces es 422 (la fila ganadora sería arbitraria)', async () => {
      await expect(
        service.upsertForProject(
          ORG,
          PROJECT,
          {
            items: [
              { ticketTypeId: hijo.id, slaPolicyId: 'policy-1' },
              { ticketTypeId: hijo.id, isActive: false },
            ],
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: 'SLA_CONTRACT_DUPLICATE_TYPE', statusCode: 422 });
    });
  });
});

/**
 * #48 T1b — la matriz lleva la jerarquía, para que el centro de contratación no
 * tenga que pedir el catálogo de tipos por separado (un tercer fetch cuyo fallo
 * el editor viejo se tragaba en silencio).
 */
describe('SlaContractService — getByProject: jerarquía en la matriz (#48 T1b)', () => {
  let service: SlaContractService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';
  const PROJECT = 'project-1';

  const padre = {
    id: 'type-inc',
    name: 'Incidencia',
    slug: 'incidencia',
    parentId: null,
    path: 'incidencia',
    level: 0,
    // Carpeta pura: el padre no se le ofrece al cliente, pero sus hijos sí.
    clientVisible: false,
  };
  const hijo = {
    id: 'type-err',
    name: 'Error del sistema',
    slug: 'error-del-sistema',
    parentId: 'type-inc',
    path: 'incidencia/error-del-sistema',
    level: 1,
    clientVisible: true,
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new SlaContractService(prisma, mockDeep<EventEmitter2>());
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT,
      name: 'Proyecto Demo',
      slaPolicyId: null,
    } as never);
  });

  it('cada fila trae parentId, path, level y clientVisible', async () => {
    prisma.ticketType.findMany.mockResolvedValue([padre, hijo] as never);
    prisma.projectTicketTypeSla.findMany.mockResolvedValue([
      {
        id: 'contract-1',
        ticketTypeId: hijo.id,
        slaPolicyId: 'policy-1',
        contractNotes: null,
        isActive: true,
        slaPolicy: { id: 'policy-1', name: 'Crítica 4h' },
      },
    ] as never);

    const res = await service.getByProject(ORG, PROJECT);

    expect(res.items).toEqual([
      expect.objectContaining({
        ticketTypeId: padre.id,
        parentId: null,
        path: 'incidencia',
        level: 0,
        isActive: false,
        // La carpeta viaja igual: el staff la ve y la administra desde acá.
        clientVisible: false,
      }),
      expect.objectContaining({
        ticketTypeId: hijo.id,
        parentId: padre.id,
        path: 'incidencia/error-del-sistema',
        level: 1,
        isActive: true,
        clientVisible: true,
        slaPolicyName: 'Crítica 4h',
      }),
    ]);
  });

  it('ordena por path y después por nombre: cada hijo cae debajo de su padre', async () => {
    prisma.ticketType.findMany.mockResolvedValue([] as never);
    prisma.projectTicketTypeSla.findMany.mockResolvedValue([] as never);

    await service.getByProject(ORG, PROJECT);

    expect(prisma.ticketType.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG, isActive: true },
      orderBy: [{ path: 'asc' }, { name: 'asc' }],
    });
  });
});

/**
 * #48 T6 — el índice de cobertura, adelgazado.
 *
 * Salieron `isComplete`/`coveredTypes`/`missingTypes` (decisión 5 del dueño) y
 * entró el eje que faltaba: QUÉ VE EL CLIENTE. El test que importa es el de la
 * contradicción vieja — un proyecto sin contratos aparecía como "0 cubiertos"
 * mientras el portal le ofrecía TODO al cliente, justamente porque no los tiene.
 *
 * No había ningún test de `getCoverage` antes de esta feature.
 */
describe('SlaContractService — getCoverage (#48 T6)', () => {
  let service: SlaContractService;
  let prisma: DeepMockProxy<PrismaService>;

  const ORG = 'org-1';

  const project = (over: Record<string, unknown> = {}) => ({
    id: 'p-1',
    name: 'Proyecto Demo',
    slaPolicyId: null,
    client: { id: 'c-1', name: 'Cliente Demo', defaultSlaPolicyId: null },
    slaContracts: [],
    ...over,
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new SlaContractService(prisma, mockDeep<EventEmitter2>());
    prisma.ticketType.count.mockResolvedValue(12 as never);
  });

  it('ya NO devuelve isComplete, coveredTypes ni missingTypes', async () => {
    prisma.project.findMany.mockResolvedValue([project()] as never);

    const res = await service.getCoverage(ORG);

    expect(res).not.toHaveProperty('completeProjects');
    expect(res).not.toHaveProperty('totalTypes');
    expect(res.items[0]).not.toHaveProperty('isComplete');
    expect(res.items[0]).not.toHaveProperty('coveredTypes');
    expect(res.items[0]).not.toHaveProperty('missingTypes');
  });

  it('proyecto SIN contratos aplicables → permisivo: el cliente ve TODOS los tipos visibles', async () => {
    prisma.project.findMany.mockResolvedValue([project()] as never);

    const res = await service.getCoverage(ORG);

    expect(res.items[0]).toMatchObject({
      clientSeesAllTypes: true,
      clientVisibleTypeCount: 12,
    });
    expect(res.totalVisibleTypes).toBe(12);
  });

  it('proyecto CON contratos → el cliente ve exactamente esos', async () => {
    prisma.project.findMany.mockResolvedValue([
      project({ slaContracts: [{ ticketTypeId: 't-1' }, { ticketTypeId: 't-2' }] }),
    ] as never);

    const res = await service.getCoverage(ORG);

    expect(res.items[0]).toMatchObject({
      clientSeesAllTypes: false,
      clientVisibleTypeCount: 2,
    });
  });

  /**
   * El criterio de "contrato aplicable" tiene que ser EL MISMO que el de la
   * disponibilidad del portal. Si divergieran, esta pantalla diría un número y el
   * portal ofrecería otro — que es justo la contradicción que #48 viene a matar.
   */
  it('solo cuenta contratos vivos sobre tipos activos Y VISIBLES (mismo criterio que el portal)', async () => {
    prisma.project.findMany.mockResolvedValue([project()] as never);

    await service.getCoverage(ORG);

    const select = (prisma.project.findMany.mock.calls[0][0] as { select: any }).select;
    expect(select.slaContracts.where).toMatchObject({
      isActive: true,
      slaPolicy: { organizationId: ORG, isActive: true },
      ticketType: { organizationId: ORG, isActive: true, clientVisible: true },
    });
    expect(prisma.ticketType.count.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG, isActive: true, clientVisible: true },
    });
  });

  it('un proyecto cuyos únicos contratos son carpetas ocultas cae a permisivo, no a "0 tipos"', async () => {
    // El `where` con `clientVisible: true` deja `slaContracts` vacío.
    prisma.project.findMany.mockResolvedValue([project({ slaContracts: [] })] as never);

    const res = await service.getCoverage(ORG);

    expect(res.items[0].clientSeesAllTypes).toBe(true);
    expect(res.items[0].clientVisibleTypeCount).toBe(12);
  });

  it('solo proyectos ACTIVOS (los archivados no reciben tickets nuevos)', async () => {
    prisma.project.findMany.mockResolvedValue([] as never);

    await service.getCoverage(ORG);

    expect(prisma.project.findMany.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG, lifecycleStatus: 'ACTIVE' },
    });
  });
});
