import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { BillingVariablesService } from '../billing-variables.service';
import { PrismaService } from '../../../database/prisma.service';
import { UpsertVariablesDto } from '../dto/upsert-variables.dto';

/**
 * #23 — CRUD del statement + total comercial SERVER-SIDE + candado anti-doble-cobro. Prisma MOCKEADO.
 */
describe('BillingVariablesService (#23)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: BillingVariablesService;

  const ORG = 'org-1';
  const CLIENT = 'cli-1';
  const PERIOD = '2026-04';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new BillingVariablesService(prisma);
    // assertClient
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, botmakerAccountId: 'ACC' } as never);
  });

  it('get: calcula el total comercial en el backend (suma de commercialValue)', async () => {
    prisma.clientBillingStatement.findUnique.mockResolvedValue({
      items: [
        { label: 'A', rawValue: 10, commercialValue: 875.17, source: 'BOTMAKER' },
        { label: 'B', rawValue: null, commercialValue: 124.83, source: 'MANUAL' },
      ],
      note: 'abril',
      billedCycleId: null,
    } as never);

    const res = await service.get(ORG, CLIENT, PERIOD);
    expect(res.totalCommercial).toBe(1000); // 875.17 + 124.83
    expect(res.billed).toBe(false);
    expect(res.items).toHaveLength(2);
  });

  it('upsert: recalcula el total y persiste; bloquea si ya facturado', async () => {
    prisma.clientBillingStatement.findUnique.mockResolvedValue({ billedCycleId: null } as never);
    prisma.clientBillingStatement.upsert.mockResolvedValue({ note: 'x' } as never);

    const dto: UpsertVariablesDto = {
      items: [
        { label: 'SESSIONS', rawValue: 10, commercialValue: 20.5, source: 'BOTMAKER' },
        { label: 'FEE', commercialValue: 299, source: 'MANUAL' },
      ],
      note: 'x',
    };
    const res = await service.upsert(ORG, CLIENT, PERIOD, dto);
    expect(res.totalCommercial).toBe(319.5);

    // ya facturado → 409 VARIABLES_ALREADY_BILLED
    prisma.clientBillingStatement.findUnique.mockResolvedValue({ billedCycleId: 'cyc-1' } as never);
    await expect(service.upsert(ORG, CLIENT, PERIOD, dto)).rejects.toMatchObject({
      code: 'VARIABLES_ALREADY_BILLED',
    });
  });

  it('collectCommercial: solo no facturadas + commercial>0, con períodos que aportan', async () => {
    prisma.clientBillingStatement.findMany.mockResolvedValue([
      {
        period: '2026-04',
        items: [
          { label: 'A', commercialValue: 100, source: 'BOTMAKER' },
          { label: 'Z', commercialValue: 0, source: 'MANUAL' }, // excluida (0)
        ],
      },
      { period: '2026-05', items: [{ label: 'B', commercialValue: 50, source: 'MANUAL' }] },
    ] as never);

    const res = await service.collectCommercial(CLIENT, ['2026-04', '2026-05']);
    expect(res.subtotalUsd).toBe(150);
    expect(res.lines.map((l) => l.label).sort()).toEqual(['A', 'B']);
    expect(res.contributingPeriods.sort()).toEqual(['2026-04', '2026-05']);
    // filtra por billedCycleId null en la query
    expect(prisma.clientBillingStatement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ billedCycleId: null }) }),
    );
  });

  it('remove: bloquea si el statement ya fue facturado', async () => {
    prisma.clientBillingStatement.findUnique.mockResolvedValue({ billedCycleId: 'cyc-1' } as never);
    await expect(service.remove(ORG, CLIENT, PERIOD)).rejects.toMatchObject({
      code: 'VARIABLES_ALREADY_BILLED',
    });
  });

  it('unbilledByPeriod: mapea período→total solo con comercial>0', async () => {
    prisma.clientBillingStatement.findMany.mockResolvedValue([
      { period: '2026-04', items: [{ label: 'A', commercialValue: 100, source: 'BOTMAKER' }] },
      { period: '2026-05', items: [{ label: 'B', commercialValue: 0, source: 'MANUAL' }] }, // excluido
    ] as never);
    const map = await service.unbilledByPeriod(CLIENT);
    expect(map.get('2026-04')).toBe(100);
    expect(map.has('2026-05')).toBe(false);
  });
});
