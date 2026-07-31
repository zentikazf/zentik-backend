import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { BillingVariablesService, computeCommercial } from '../billing-variables.service';
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

/**
 * #23 — Regla de precio por variable: fórmula (computeCommercial) + herencia del contrato (applyContractRules).
 */
describe('Reglas de precio de variables (#23)', () => {
  const ORG = 'org-1';
  const CLIENT = 'cli-1';

  it('upsert PERSISTE la regla (mode/incluidas/unitPrice) y recalcula el comercial server-side', async () => {
    const prisma = mockDeep<PrismaService>();
    const service = new BillingVariablesService(prisma);
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT } as never);
    prisma.clientBillingStatement.findUnique.mockResolvedValue({ billedCycleId: null } as never);
    prisma.clientBillingStatement.upsert.mockResolvedValue({ note: null } as never);

    await service.upsert(ORG, CLIENT, '2026-07', {
      items: [
        { label: 'SESSIONS', usage: 12670, rawValue: 123, commercialValue: 999, source: 'BOTMAKER', mode: 'CALCULO', incluidas: 3000, unitPrice: 0.065 },
        { label: 'WA', rawValue: 285.35, commercialValue: 0, source: 'BOTMAKER', mode: 'DIRECTO' },
        { label: 'FEE', commercialValue: 299, source: 'MANUAL', mode: 'MANUAL' },
      ],
    } as never);

    const stored = (prisma.clientBillingStatement.upsert.mock.calls[0][0].create as { items: unknown }).items as Array<Record<string, unknown>>;
    const sessions = stored.find((i) => i.label === 'SESSIONS')!;
    expect(sessions.mode).toBe('CALCULO');
    expect(sessions.incluidas).toBe(3000);
    expect(sessions.unitPrice).toBe(0.065);
    expect(sessions.commercialValue).toBe(628.55); // recalculado server-side (ignora el 999 mandado)
    expect((stored.find((i) => i.label === 'WA'))!.commercialValue).toBe(285.35); // DIRECTO = crudo
    expect((stored.find((i) => i.label === 'FEE'))!.commercialValue).toBe(299); // MANUAL se respeta
  });

  describe('computeCommercial', () => {
    it('DIRECTO → comercial = crudo', () => {
      expect(computeCommercial({ mode: 'DIRECTO', rawValue: 285.35, usage: 3535 })).toBe(285.35);
    });
    it('CALCULO → max(0, usage − incluidas) × unitPrice (casos reales de Fortaleza)', () => {
      // Sessions: (12670 − 3000) × 0.065 = 628.55
      expect(computeCommercial({ mode: 'CALCULO', usage: 12670, incluidas: 3000, unitPrice: 0.065 })).toBe(628.55);
      // WhatsApp line: (2 − 1) × 100 = 100
      expect(computeCommercial({ mode: 'CALCULO', usage: 2, incluidas: 1, unitPrice: 100 })).toBe(100);
      // Agents: (30 − 6) × 10 = 240
      expect(computeCommercial({ mode: 'CALCULO', usage: 30, incluidas: 6, unitPrice: 10 })).toBe(240);
      // AV scan: 252 × 0.024 = 6.05 (incluidas 0)
      expect(computeCommercial({ mode: 'CALCULO', usage: 252, incluidas: 0, unitPrice: 0.024 })).toBe(6.05);
    });
    it('CALCULO nunca da negativo si usage < incluidas', () => {
      expect(computeCommercial({ mode: 'CALCULO', usage: 100, incluidas: 3000, unitPrice: 0.065 })).toBe(0);
    });
    it('CALCULO op=DIV → cobrables ÷ divisor (tokens por USD); divisor 0 → 0', () => {
      // Tokens: 37.409.709 ÷ 625.000 unidades/USD = 59.86
      expect(computeCommercial({ mode: 'CALCULO', usage: 37409709, incluidas: 0, unitPrice: 625000, op: 'DIV' })).toBe(59.86);
      // Con incluidas: (1.000.000 − 500.000) ÷ 250.000 = 2
      expect(computeCommercial({ mode: 'CALCULO', usage: 1000000, incluidas: 500000, unitPrice: 250000, op: 'DIV' })).toBe(2);
      // Divisor 0 → 0 (nunca división por cero / Infinity)
      expect(computeCommercial({ mode: 'CALCULO', usage: 100, incluidas: 0, unitPrice: 0, op: 'DIV' })).toBe(0);
      // op ausente → MULT (backwards-compat con reglas ya guardadas)
      expect(computeCommercial({ mode: 'CALCULO', usage: 10, incluidas: 0, unitPrice: 2 })).toBe(20);
    });
    it('MANUAL / sin regla → respeta el comercial tipeado', () => {
      expect(computeCommercial({ mode: 'MANUAL', commercialValue: 299 })).toBe(299);
      expect(computeCommercial({ commercialValue: 149 })).toBe(149);
    });
  });

  describe('applyContractRules', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let service: BillingVariablesService;
    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      service = new BillingVariablesService(prisma);
    });

    it('arrastra la regla del mes anterior y recalcula con el usage NUEVO', async () => {
      // Contrato definido el mes pasado: Sessions CALCULO(3000, 0.065), Fee MANUAL 299.
      prisma.clientBillingStatement.findFirst.mockResolvedValue({
        items: [
          { label: 'SESSIONS', mode: 'CALCULO', incluidas: 3000, unitPrice: 0.065, commercialValue: 628.55, source: 'BOTMAKER' },
          { label: 'FEE', mode: 'MANUAL', commercialValue: 299, source: 'BOTMAKER' },
          { label: 'TOKENS', mode: 'CALCULO', incluidas: 0, unitPrice: 625000, op: 'DIV', commercialValue: 59.86, source: 'BOTMAKER' },
        ],
      } as never);

      // Import del mes nuevo (usage distinto).
      const imported = [
        { label: 'SESSIONS', usage: 5000, rawValue: 100, commercialValue: 0, source: 'BOTMAKER' as const },
        { label: 'FEE', usage: 1, rawValue: 149, commercialValue: 0, source: 'BOTMAKER' as const },
        { label: 'TOKENS', usage: 1250000, rawValue: 3, commercialValue: 0, source: 'BOTMAKER' as const },
        { label: 'NUEVA', usage: 10, rawValue: 5, commercialValue: 0, source: 'BOTMAKER' as const }, // sin contrato previo
      ];
      const res = await service.applyContractRules(CLIENT, imported);

      const sessions = res.find((r) => r.label === 'SESSIONS')!;
      expect(sessions.mode).toBe('CALCULO');
      expect(sessions.commercialValue).toBe(130); // (5000 − 3000) × 0.065
      const fee = res.find((r) => r.label === 'FEE')!;
      expect(fee.mode).toBe('MANUAL');
      expect(fee.commercialValue).toBe(299); // MANUAL arrastra el valor fijo
      const tokens = res.find((r) => r.label === 'TOKENS')!;
      expect(tokens.op).toBe('DIV'); // la operación también se hereda
      expect(tokens.commercialValue).toBe(2); // 1.250.000 ÷ 625.000 con el usage nuevo
      const nueva = res.find((r) => r.label === 'NUEVA')!;
      expect(nueva.mode).toBeUndefined(); // sin regla previa → el admin la define
      expect(nueva.commercialValue).toBe(0);
    });

    it('sin statement previa → todo comercial 0 (a definir)', async () => {
      prisma.clientBillingStatement.findFirst.mockResolvedValue(null as never);
      const res = await service.applyContractRules(CLIENT, [
        { label: 'SESSIONS', usage: 100, rawValue: 10, commercialValue: 0, source: 'BOTMAKER' as const },
      ]);
      expect(res[0].commercialValue).toBe(0);
      expect(res[0].usage).toBe(100);
    });
  });
});
