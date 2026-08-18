import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../database/prisma.service';
import { ContractPackageService } from './contract-package.service';
import { SlaContractService } from './sla-contract.service';

/**
 * Tests de los paquetes de contratos default (#58 T3 y T4).
 *
 * Prisma MOCKEADO (jest-mock-extended). NUNCA toca una DB real.
 *
 * ── Qué custodian ───────────────────────────────────────────────────────────
 * Las reglas de este service son fáciles de romper porque las tres son
 * "negativas" — se tratan de cosas que NO tienen que pasar:
 *
 *  1. Un contrato DESACTIVADO cuenta como **nuevo (reactivar)**, nunca como
 *     "ya igual", aunque su política sea idéntica a la del paquete. Es el error
 *     natural (`policyId === policyId` → "no hay nada que hacer") y dejaría al
 *     cliente sin ver ese tipo después de un apply que dijo "todo al día".
 *  2. Aplicar **NUNCA apaga**. El write-set no puede contener `isActive: false`
 *     ni mencionar un tipo que el paquete no trae — y como `upsertForProject`
 *     deja intacto lo omitido, no mencionarlo ES la garantía.
 *  3. Se pisa **solo lo tildado**. Sin checkbox, un "configurado distinto"
 *     sobrevive intacto.
 *
 * Y dos de plomería que también se rompen en silencio: el log se escribe aun con
 * 0 cambios (si no, el proyecto nunca entra en "usado en N proyectos") y las
 * `contractNotes` del contrato existente se REENVÍAN al pisar (el upsert
 * persiste la fila completa: omitirlas las borra).
 */

const ORG = 'org-1';
const PROJECT = 'project-1';
const PACKAGE = 'pkg-1';
const USER = 'user-1';

const POLICY_STANDARD = { id: 'pol-std', name: 'Estándar 4h', isActive: true };
const POLICY_CRITICAL = { id: 'pol-crit', name: 'Crítico 2h', isActive: true };
const POLICY_DEAD = { id: 'pol-dead', name: 'Vieja', isActive: false };

const TYPE_ERROR = { id: 'type-err', name: 'Error en colas', isActive: true, path: 'inc/error' };
const TYPE_CAIDA = { id: 'type-caida', name: 'Caída total', isActive: true, path: 'inc/caida' };
const TYPE_OFF = { id: 'type-off', name: 'Tipo apagado', isActive: false, path: 'inc/off' };

/** Un ítem del paquete tal como lo devuelve el `include` de `buildPlan`. */
function packageItem(
  type: typeof TYPE_ERROR,
  policy: typeof POLICY_STANDARD,
): Record<string, unknown> {
  return {
    id: `item-${type.id}`,
    packageId: PACKAGE,
    ticketTypeId: type.id,
    slaPolicyId: policy.id,
    ticketType: type,
    slaPolicy: policy,
  };
}

/** Una fila de `project_ticket_type_slas` tal como la devuelve el `include`. */
function contractRow(
  typeId: string,
  policy: typeof POLICY_STANDARD,
  overrides: { isActive?: boolean; contractNotes?: string | null } = {},
): Record<string, unknown> {
  return {
    id: `contract-${typeId}`,
    projectId: PROJECT,
    ticketTypeId: typeId,
    slaPolicyId: policy.id,
    contractNotes: overrides.contractNotes ?? null,
    isActive: overrides.isActive ?? true,
    slaPolicy: { id: policy.id, name: policy.name },
  };
}

describe('ContractPackageService — preview y apply (#58 T4)', () => {
  let service: ContractPackageService;
  let prisma: DeepMockProxy<PrismaService>;
  let eventEmitter: DeepMockProxy<EventEmitter2>;
  let contracts: DeepMockProxy<SlaContractService>;

  /** Arma el escenario: qué trae el paquete y qué tiene hoy el proyecto. */
  function setup(
    items: Record<string, unknown>[],
    projectContracts: Record<string, unknown>[] = [],
    packageIsActive = true,
  ) {
    prisma.contractPackage.findFirst.mockResolvedValue({
      id: PACKAGE,
      organizationId: ORG,
      name: 'Soporte estándar',
      isActive: packageIsActive,
      items,
    } as never);
    prisma.project.findFirst.mockResolvedValue({ id: PROJECT, name: 'Proyecto Demo' } as never);
    prisma.projectTicketTypeSla.findMany.mockResolvedValue(projectContracts as never);
    prisma.contractPackageApplication.create.mockResolvedValue({ id: 'app-1' } as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    eventEmitter = mockDeep<EventEmitter2>();
    contracts = mockDeep<SlaContractService>();
    service = new ContractPackageService(prisma, eventEmitter, contracts);

    contracts.upsertForProject.mockResolvedValue({ items: [] } as never);
    contracts.getByProject.mockResolvedValue({ items: [] } as never);
  });

  describe('las 3 categorías del preview (R4.3)', () => {
    it('clasifica nuevo / ya igual / distinto en el balde que corresponde', async () => {
      setup(
        [
          packageItem(TYPE_ERROR, POLICY_CRITICAL), // el proyecto lo tiene con otra
          packageItem(TYPE_CAIDA, POLICY_STANDARD), // el proyecto lo tiene igual
        ],
        [
          contractRow(TYPE_ERROR.id, POLICY_STANDARD),
          contractRow(TYPE_CAIDA.id, POLICY_STANDARD),
        ],
      );

      const preview = await service.preview(ORG, PROJECT, PACKAGE);

      expect(preview.toCreate).toHaveLength(0);
      expect(preview.alreadySame.map((r) => r.ticketTypeId)).toEqual([TYPE_CAIDA.id]);
      expect(preview.different).toHaveLength(1);
      expect(preview.different[0]).toMatchObject({
        ticketTypeId: TYPE_ERROR.id,
        packagePolicyName: 'Crítico 2h',
        currentPolicyName: 'Estándar 4h',
        reactivates: false,
      });
    });

    it('un tipo SIN contrato es nuevo', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], []);

      const preview = await service.preview(ORG, PROJECT, PACKAGE);

      expect(preview.toCreate.map((r) => r.ticketTypeId)).toEqual([TYPE_ERROR.id]);
      expect(preview.toCreate[0].reactivates).toBe(false);
      expect(preview.toCreate[0].currentPolicyId).toBeNull();
    });

    /**
     * El caso que se equivoca solo: la política COINCIDE, así que la comparación
     * ingenua lo mandaría a "ya igual" y el apply no escribiría nada — dejando el
     * contrato apagado y al cliente sin ver el tipo.
     */
    it('un contrato DESACTIVADO es NUEVO (reactivar), aunque traiga la MISMA política', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_STANDARD)],
        [contractRow(TYPE_ERROR.id, POLICY_STANDARD, { isActive: false })],
      );

      const preview = await service.preview(ORG, PROJECT, PACKAGE);

      expect(preview.alreadySame).toHaveLength(0);
      expect(preview.different).toHaveLength(0);
      expect(preview.toCreate).toHaveLength(1);
      expect(preview.toCreate[0]).toMatchObject({
        ticketTypeId: TYPE_ERROR.id,
        reactivates: true,
        // No hay política vigente que mostrar: el contrato está apagado.
        currentPolicyId: null,
        currentPolicyName: null,
      });
    });

    it('el preview no escribe nada', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], []);

      await service.preview(ORG, PROJECT, PACKAGE);

      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(prisma.contractPackageApplication.create).not.toHaveBeenCalled();
    });
  });

  describe('tolerancia a paquetes podridos (R4.5)', () => {
    it('salta el ítem con la política desactivada, lo reporta y aplica el resto', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_DEAD), packageItem(TYPE_CAIDA, POLICY_STANDARD)], []);

      const result = await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(result.skipped).toEqual([
        {
          ticketTypeId: TYPE_ERROR.id,
          ticketTypeName: TYPE_ERROR.name,
          reason: 'POLICY_INACTIVE',
          detail: 'la política "Vieja" está desactivada',
        },
      ]);
      // El tipo sano entró igual: un ítem podrido no rompe el paquete entero.
      expect(result.createdCount).toBe(1);
      expect(contracts.upsertForProject.mock.calls[0][2]).toEqual({
        items: [{ ticketTypeId: TYPE_CAIDA.id, slaPolicyId: POLICY_STANDARD.id, isActive: true }],
      });
    });

    it('salta el ítem cuyo TIPO está inactivo', async () => {
      setup([packageItem(TYPE_OFF, POLICY_STANDARD)], []);

      const result = await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(result.skipped[0]).toMatchObject({ reason: 'TYPE_INACTIVE' });
      expect(contracts.upsertForProject).not.toHaveBeenCalled();
    });
  });

  describe('qué escribe el apply', () => {
    it('crea los nuevos y NO menciona lo que el paquete no trae (nunca apaga, R4.4)', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL)],
        // El proyecto tiene contratado un tipo que el paquete NO menciona.
        [contractRow(TYPE_CAIDA.id, POLICY_STANDARD)],
      );

      await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      const payload = contracts.upsertForProject.mock.calls[0][2] as {
        items: { ticketTypeId: string; isActive?: boolean }[];
      };
      expect(payload.items.map((i) => i.ticketTypeId)).toEqual([TYPE_ERROR.id]);
      // Ni una sola fila apagando algo: la garantía de R4.4 es no mencionarlo.
      expect(payload.items.every((i) => i.isActive === true)).toBe(true);
    });

    it('sin checkbox NO pisa lo configurado distinto', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL)],
        [contractRow(TYPE_ERROR.id, POLICY_STANDARD)],
      );

      const result = await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(result.overwrittenCount).toBe(0);
      expect(result.skippedDifferentCount).toBe(1);
    });

    it('pisa SOLO el tipo tildado, no los demás conflictos', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL), packageItem(TYPE_CAIDA, POLICY_CRITICAL)],
        [
          contractRow(TYPE_ERROR.id, POLICY_STANDARD),
          contractRow(TYPE_CAIDA.id, POLICY_STANDARD),
        ],
      );

      const result = await service.apply(
        ORG,
        PROJECT,
        { packageId: PACKAGE, items: [{ ticketTypeId: TYPE_ERROR.id, overwrite: true }] },
        USER,
      );

      expect(contracts.upsertForProject.mock.calls[0][2]).toEqual({
        items: [{ ticketTypeId: TYPE_ERROR.id, slaPolicyId: POLICY_CRITICAL.id, isActive: true }],
      });
      expect(result.overwrittenCount).toBe(1);
      expect(result.skippedDifferentCount).toBe(1);
    });

    it('`overwrite: false` explícito se comporta como no tildado', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL)],
        [contractRow(TYPE_ERROR.id, POLICY_STANDARD)],
      );

      const result = await service.apply(
        ORG,
        PROJECT,
        { packageId: PACKAGE, items: [{ ticketTypeId: TYPE_ERROR.id, overwrite: false }] },
        USER,
      );

      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(result.overwrittenCount).toBe(0);
    });

    /**
     * `upsertForProject` persiste la fila COMPLETA (`contractNotes ?? null`), así
     * que omitir las notas no es "no las toques": las borra. El paquete no edita
     * notas, entonces las reenvía tal cual.
     */
    it('reenvía las contractNotes del contrato existente al pisarlo', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL)],
        [contractRow(TYPE_ERROR.id, POLICY_STANDARD, { contractNotes: 'Adenda 3 del contrato' })],
      );

      await service.apply(
        ORG,
        PROJECT,
        { packageId: PACKAGE, items: [{ ticketTypeId: TYPE_ERROR.id, overwrite: true }] },
        USER,
      );

      expect(contracts.upsertForProject.mock.calls[0][2]).toEqual({
        items: [
          {
            ticketTypeId: TYPE_ERROR.id,
            slaPolicyId: POLICY_CRITICAL.id,
            contractNotes: 'Adenda 3 del contrato',
            isActive: true,
          },
        ],
      });
    });

    it('reenvía las contractNotes al REACTIVAR un contrato apagado', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_CRITICAL)],
        [
          contractRow(TYPE_ERROR.id, POLICY_STANDARD, {
            isActive: false,
            contractNotes: 'Nota vieja',
          }),
        ],
      );

      await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(contracts.upsertForProject.mock.calls[0][2]).toEqual({
        items: [
          {
            ticketTypeId: TYPE_ERROR.id,
            slaPolicyId: POLICY_CRITICAL.id,
            contractNotes: 'Nota vieja',
            isActive: true,
          },
        ],
      });
    });
  });

  describe('el rastro (R1.5 / R4.6)', () => {
    it('escribe la aplicación AUN con 0 creados y 0 pisados', async () => {
      setup(
        [packageItem(TYPE_ERROR, POLICY_STANDARD)],
        [contractRow(TYPE_ERROR.id, POLICY_STANDARD)],
      );

      const result = await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(result.isNoop).toBe(true);
      expect(prisma.contractPackageApplication.create).toHaveBeenCalledTimes(1);
      expect(prisma.contractPackageApplication.create.mock.calls[0][0]).toEqual({
        data: {
          packageId: PACKAGE,
          projectId: PROJECT,
          appliedById: USER,
          createdCount: 0,
          overwrittenCount: 0,
          skippedSameCount: 1,
          skippedDifferentCount: 0,
        },
      });
    });

    it('los contadores del log espejan lo que pasó', async () => {
      setup(
        [
          packageItem(TYPE_ERROR, POLICY_CRITICAL), // distinto, tildado
          packageItem(TYPE_CAIDA, POLICY_STANDARD), // ya igual
          packageItem(TYPE_OFF, POLICY_STANDARD), // podrido: no cuenta en ningún balde
        ],
        [
          contractRow(TYPE_ERROR.id, POLICY_STANDARD),
          contractRow(TYPE_CAIDA.id, POLICY_STANDARD),
        ],
      );

      await service.apply(
        ORG,
        PROJECT,
        { packageId: PACKAGE, items: [{ ticketTypeId: TYPE_ERROR.id, overwrite: true }] },
        USER,
      );

      expect(prisma.contractPackageApplication.create.mock.calls[0][0]).toMatchObject({
        data: {
          createdCount: 0,
          overwrittenCount: 1,
          skippedSameCount: 1,
          skippedDifferentCount: 0,
        },
      });
    });

    it('emite `sla.package.applied` (el `sla.contract.upserted` del bulk no dice qué paquete fue)', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], []);

      await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'sla.package.applied',
        expect.objectContaining({
          packageId: PACKAGE,
          projectId: PROJECT,
          organizationId: ORG,
          createdCount: 1,
        }),
      );
    });

    /**
     * El orden es deliberado (ver el docstring de `apply`): al revés, una falla al
     * escribir contratos dejaría el log mintiendo sobre lo que pasó.
     */
    it('escribe primero los contratos y después el log', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], []);
      const order: string[] = [];
      contracts.upsertForProject.mockImplementation((async () => {
        order.push('contratos');
        return { items: [] };
      }) as never);
      prisma.contractPackageApplication.create.mockImplementation((async () => {
        order.push('log');
        return { id: 'app-1' };
      }) as never);

      await service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER);

      expect(order).toEqual(['contratos', 'log']);
    });
  });

  describe('paquete vacío (R3.3)', () => {
    it('el preview lo marca como vacío en vez de fingir que hay algo para hacer', async () => {
      setup([], []);

      const preview = await service.preview(ORG, PROJECT, PACKAGE);

      expect(preview.isEmpty).toBe(true);
      expect(preview.toCreate).toHaveLength(0);
    });

    it('aplicarlo es un 422 con mensaje, no un éxito mudo — y no escribe NADA', async () => {
      setup([], []);

      await expect(service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER)).rejects.toMatchObject(
        { code: 'SLA_PACKAGE_EMPTY', statusCode: 422 },
      );
      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(prisma.contractPackageApplication.create).not.toHaveBeenCalled();
    });
  });

  /**
   * Archivar es la ÚNICA forma de retirar un paquete (no hay DELETE), y el guard
   * `SLA_POLICY_IN_USE` solo cuenta ítems de paquetes ACTIVOS: archivar
   * DESBLOQUEA dar de baja las políticas que ese paquete usa. Si encima se
   * pudiera aplicar, la cadena "archivar → dar de baja la política → aplicar
   * igual" terminaría en un paquete que se salta sus propios ítems en silencio.
   */
  describe('paquete archivado', () => {
    it('no se puede aplicar: 422 y no escribe nada', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], [], false);

      await expect(service.apply(ORG, PROJECT, { packageId: PACKAGE }, USER)).rejects.toMatchObject(
        { code: 'SLA_PACKAGE_INACTIVE', statusCode: 422 },
      );
      expect(contracts.upsertForProject).not.toHaveBeenCalled();
      expect(prisma.contractPackageApplication.create).not.toHaveBeenCalled();
    });

    it('el preview SÍ lo deja mirar, y dice que está archivado', async () => {
      setup([packageItem(TYPE_ERROR, POLICY_STANDARD)], [], false);

      const preview = await service.preview(ORG, PROJECT, PACKAGE);

      expect(preview.package.isActive).toBe(false);
      expect(preview.toCreate).toHaveLength(1);
    });
  });

  describe('scoping multi-tenant', () => {
    it('un paquete de otra organización es 404, no 403', async () => {
      prisma.contractPackage.findFirst.mockResolvedValue(null as never);
      prisma.project.findFirst.mockResolvedValue({ id: PROJECT, name: 'Demo' } as never);

      await expect(service.preview(ORG, PROJECT, PACKAGE)).rejects.toMatchObject({
        code: 'SLA_PACKAGE_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('un proyecto de otra organización es 404', async () => {
      prisma.contractPackage.findFirst.mockResolvedValue({
        id: PACKAGE,
        name: 'P',
        items: [],
      } as never);
      prisma.project.findFirst.mockResolvedValue(null as never);

      await expect(service.preview(ORG, PROJECT, PACKAGE)).rejects.toMatchObject({
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    });
  });
});

describe('ContractPackageService — upsertItems (#58 T3)', () => {
  let service: ContractPackageService;
  let prisma: DeepMockProxy<PrismaService>;
  let lastTx: DeepMockProxy<Prisma.TransactionClient>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new ContractPackageService(prisma, mockDeep<EventEmitter2>(), mockDeep<SlaContractService>());

    prisma.contractPackage.findFirst.mockResolvedValue({
      id: PACKAGE,
      organizationId: ORG,
      name: 'Soporte estándar',
    } as never);
    // "todo lo que pediste existe": tantas filas como ids se consultaron.
    const countAsAllFound = (args: unknown) =>
      Promise.resolve(((args as { where: { id: { in: string[] } } }).where.id.in ?? []).length);
    prisma.ticketType.count.mockImplementation(countAsAllFound as never);
    prisma.slaPolicy.count.mockImplementation(countAsAllFound as never);
    // `upsertItems` cierra devolviendo `getById`.
    prisma.ticketType.findMany.mockResolvedValue([] as never);
    prisma.contractPackageItem.findMany.mockResolvedValue([] as never);
    prisma.contractPackageApplication.findMany.mockResolvedValue([] as never);

    prisma.$transaction.mockImplementation(async (cb: unknown) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      lastTx = tx;
      return (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
    });
  });

  /**
   * La diferencia semántica con el PUT de contratos, y la razón por la que el
   * ítem no tiene `isActive`: en un paquete "no está" es una fila AUSENTE.
   */
  it('destildar BORRA la fila del paquete (no la desactiva)', async () => {
    await service.upsertItems(
      ORG,
      PACKAGE,
      { items: [{ ticketTypeId: TYPE_ERROR.id, isActive: false }] },
      USER,
    );

    expect(lastTx.contractPackageItem.deleteMany).toHaveBeenCalledWith({
      where: { packageId: PACKAGE, ticketTypeId: TYPE_ERROR.id },
    });
    expect(lastTx.contractPackageItem.upsert).not.toHaveBeenCalled();
  });

  it('tildar hace upsert por el par (paquete, tipo)', async () => {
    await service.upsertItems(
      ORG,
      PACKAGE,
      { items: [{ ticketTypeId: TYPE_ERROR.id, slaPolicyId: POLICY_STANDARD.id }] },
      USER,
    );

    expect(lastTx.contractPackageItem.upsert).toHaveBeenCalledWith({
      where: { packageId_ticketTypeId: { packageId: PACKAGE, ticketTypeId: TYPE_ERROR.id } },
      create: {
        packageId: PACKAGE,
        ticketTypeId: TYPE_ERROR.id,
        slaPolicyId: POLICY_STANDARD.id,
      },
      update: { slaPolicyId: POLICY_STANDARD.id },
    });
  });

  it('sacar un tipo que no estaba es un no-op, no un error', async () => {
    await expect(
      service.upsertItems(
        ORG,
        PACKAGE,
        { items: [{ ticketTypeId: 'type-que-nunca-estuvo', isActive: false }] },
        USER,
      ),
    ).resolves.toBeDefined();
  });

  it('el mismo tipo dos veces es 422 (la fila ganadora sería arbitraria)', async () => {
    await expect(
      service.upsertItems(
        ORG,
        PACKAGE,
        {
          items: [
            { ticketTypeId: TYPE_ERROR.id, slaPolicyId: POLICY_STANDARD.id },
            { ticketTypeId: TYPE_ERROR.id, slaPolicyId: POLICY_CRITICAL.id },
          ],
        },
        USER,
      ),
    ).rejects.toMatchObject({ code: 'SLA_PACKAGE_DUPLICATE_TYPE', statusCode: 422 });
  });

  it('un ítem que entra sin política es 422', async () => {
    await expect(
      service.upsertItems(ORG, PACKAGE, { items: [{ ticketTypeId: TYPE_ERROR.id }] }, USER),
    ).rejects.toMatchObject({ code: 'SLA_POLICY_REQUIRED', statusCode: 422 });
  });

  it('una política desactivada no se puede meter en el paquete', async () => {
    prisma.slaPolicy.count.mockResolvedValue(0 as never);

    await expect(
      service.upsertItems(
        ORG,
        PACKAGE,
        { items: [{ ticketTypeId: TYPE_ERROR.id, slaPolicyId: POLICY_DEAD.id }] },
        USER,
      ),
    ).rejects.toMatchObject({ code: 'SLA_POLICY_NOT_FOUND', statusCode: 404 });
  });

  it('un paquete de otra organización es 404', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue(null as never);

    await expect(service.upsertItems(ORG, PACKAGE, { items: [] }, USER)).rejects.toMatchObject({
      code: 'SLA_PACKAGE_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('ContractPackageService — CRUD y lecturas (#58 T3)', () => {
  let service: ContractPackageService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new ContractPackageService(prisma, mockDeep<EventEmitter2>(), mockDeep<SlaContractService>());
  });

  it('el nombre es único por organización', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue({ id: 'otro' } as never);

    await expect(service.create(ORG, { name: 'Soporte estándar' }, USER)).rejects.toMatchObject({
      code: 'SLA_PACKAGE_DUPLICATE_NAME',
      statusCode: 409,
    });
    expect(prisma.contractPackage.create).not.toHaveBeenCalled();
  });

  /**
   * El DTO trimea antes de validar, así que "  " muere en el @MinLength(2). Esto
   * es la red de abajo: un nombre vacío que llegue por otro path no puede
   * guardarse — quedaria una fila sin titulo en la lista y el SEGUNDO que haga
   * lo mismo se comeria un 409 que dice `Ya existe un paquete llamado ""`.
   */
  it('un nombre de solo espacios es 422, no un paquete sin titulo', async () => {
    await expect(service.create(ORG, { name: '   ' }, USER)).rejects.toMatchObject({
      code: 'SLA_PACKAGE_NAME_REQUIRED',
      statusCode: 422,
    });
    expect(prisma.contractPackage.create).not.toHaveBeenCalled();
  });

  it('renombrar a solo espacios tampoco pasa (y no saltea el chequeo de duplicado)', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue({ id: PACKAGE, name: 'Viejo' } as never);

    await expect(service.update(ORG, PACKAGE, { name: '  ' }, USER)).rejects.toMatchObject({
      code: 'SLA_PACKAGE_NAME_REQUIRED',
      statusCode: 422,
    });
    expect(prisma.contractPackage.update).not.toHaveBeenCalled();
  });

  /** El pre-chequeo no es atómico: la unique de la DB es la autoridad. */
  it('traduce el P2002 de la carrera al MISMO 409, no a un 500', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue(null as never);
    prisma.contractPackage.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }) as never,
    );

    await expect(service.create(ORG, { name: 'Soporte estándar' }, USER)).rejects.toMatchObject({
      code: 'SLA_PACKAGE_DUPLICATE_NAME',
      statusCode: 409,
    });
  });

  /**
   * R2.5: el GET devuelve el catálogo COMPLETO con la asignación encima — mismo
   * shape que `getByProject` — para que el editor de árbol compartido lo consuma
   * sin adaptadores y sin un segundo fetch.
   */
  it('el GET devuelve el catálogo completo de tipos, no solo los ítems', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue({
      id: PACKAGE,
      name: 'Soporte estándar',
      notes: null,
      isActive: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as never);
    prisma.ticketType.findMany.mockResolvedValue([
      { id: TYPE_ERROR.id, name: TYPE_ERROR.name, parentId: 'inc', path: 'inc/error', level: 1, clientVisible: true },
      { id: TYPE_CAIDA.id, name: TYPE_CAIDA.name, parentId: 'inc', path: 'inc/caida', level: 1, clientVisible: true },
    ] as never);
    prisma.contractPackageItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        ticketTypeId: TYPE_ERROR.id,
        slaPolicyId: POLICY_STANDARD.id,
        slaPolicy: { id: POLICY_STANDARD.id, name: POLICY_STANDARD.name },
      },
    ] as never);
    prisma.contractPackageApplication.findMany.mockResolvedValue([
      { projectId: 'p1' },
      { projectId: 'p2' },
    ] as never);

    const result = await service.getById(ORG, PACKAGE);

    // Los DOS tipos, no solo el que está en el paquete.
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      ticketTypeId: TYPE_ERROR.id,
      slaPolicyId: POLICY_STANDARD.id,
      slaPolicyName: POLICY_STANDARD.name,
      isActive: true,
      contractNotes: null,
    });
    // El hueco: el tipo que el paquete NO trae viaja igual, apagado.
    expect(result.items[1]).toMatchObject({
      ticketTypeId: TYPE_CAIDA.id,
      slaPolicyId: null,
      isActive: false,
    });
    expect(result.package.usedInProjects).toBe(2);
  });

  /**
   * El log es append-only: un proyecto que recibió el paquete tres veces tiene
   * tres filas. La lista del re-aplicar tiene que mostrar UNA por proyecto, con
   * la más reciente arriba.
   */
  it('la lista de aplicaciones colapsa por proyecto y se queda con la última', async () => {
    prisma.contractPackage.findFirst.mockResolvedValue({ id: PACKAGE, name: 'P' } as never);
    prisma.contractPackageApplication.findMany.mockResolvedValue([
      {
        projectId: 'p1',
        appliedAt: new Date('2026-08-18'),
        project: { id: 'p1', name: 'Demo', lifecycleStatus: 'ACTIVE' },
        appliedBy: { id: USER, name: 'Josué' },
      },
      {
        projectId: 'p1',
        appliedAt: new Date('2026-08-01'),
        project: { id: 'p1', name: 'Demo', lifecycleStatus: 'ACTIVE' },
        appliedBy: { id: USER, name: 'Josué' },
      },
      {
        projectId: 'p2',
        appliedAt: new Date('2026-08-10'),
        project: { id: 'p2', name: 'Archivado', lifecycleStatus: 'ARCHIVED' },
        appliedBy: { id: USER, name: 'Josué' },
      },
    ] as never);

    const rows = await service.listApplications(ORG, PACKAGE);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      projectId: 'p1',
      lastAppliedAt: new Date('2026-08-18'),
      timesApplied: 2,
      projectIsActive: true,
    });
    expect(rows[1]).toMatchObject({ projectId: 'p2', projectIsActive: false, timesApplied: 1 });
  });

  it('"usado en N proyectos" cuenta proyectos DISTINTOS, no aplicaciones', async () => {
    prisma.contractPackage.findMany.mockResolvedValue([
      { id: PACKAGE, name: 'P', notes: null, isActive: true, createdAt: new Date(0), updatedAt: new Date(0), items: [] },
    ] as never);
    prisma.ticketType.findMany.mockResolvedValue([] as never);
    // El groupBy ya devuelve pares (paquete, proyecto) distintos: dos filas =
    // dos proyectos, por más que el paquete se haya aplicado 10 veces.
    prisma.contractPackageApplication.groupBy.mockResolvedValue([
      { packageId: PACKAGE, projectId: 'p1' },
      { packageId: PACKAGE, projectId: 'p2' },
    ] as never);

    const [pkg] = await service.list(ORG);

    expect(pkg.usedInProjects).toBe(2);
  });
});
