import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientBillingService } from '../client-billing.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppConfigService } from '../../../config/app.config';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

/**
 * Tests unitarios del cierre de ciclo de facturación (#25) + motor de corte por workedOn (H8b).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod). Bajo H8b el eje
 * pasó de createdAt → workedOn con arrastre 2A-ACOTADO (solo meses ya cerrados). closeCycle hace
 * 3 hoursTransaction.findMany en orden (guard R11, guard workedOn-null, candidatos) + 1
 * clientBillingCycle.findMany (closedMonthKeys); getBuilder hace 2 hoursTransaction.findMany
 * (on-time, atrasadas) + 1 count (sinFechaTrabajo) + 2 clientBillingCycle.findMany.
 */
describe('ClientBillingService (#25 + H8b)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let config: DeepMockProxy<AppConfigService>;
  let tx: DeepMockProxy<Prisma.TransactionClient>;
  let service: ClientBillingService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';
  const USER = { id: 'user-1', email: 'u@e.com', name: 'U' } as AuthenticatedUser;

  // Fecha de trabajo (UTC-midnight = día calendario Asunción). Julio por defecto (mes '2026-07').
  function makeRow(opts: {
    id: string;
    type: string;
    taskType: string | null;
    price: string | null;
    hours?: number;
    workedOn?: Date | null;
  }) {
    return {
      id: opts.id,
      type: opts.type,
      hours: opts.hours ?? 1,
      note: `note-${opts.id}`,
      createdAt: new Date('2026-07-10T12:00:00Z'),
      workedOn: opts.workedOn === undefined ? new Date(Date.UTC(2026, 6, 10)) : opts.workedOn,
      priceAmount: opts.price != null ? new Prisma.Decimal(opts.price) : null,
      priceRate: opts.price != null ? new Prisma.Decimal(opts.price) : null,
      priceCurrency: opts.price != null ? 'PYG' : null,
      task: opts.taskType ? { id: `t-${opts.id}`, title: `task-${opts.id}`, type: opts.taskType } : null,
    };
  }

  function makeCycle(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'cyc1',
      organizationId: ORG,
      clientId: CLIENT,
      status: 'DRAFT',
      invoiceNumber: 'FAC-2026-00001',
      periodStart: new Date('2026-07-01T03:00:00Z'),
      periodEnd: new Date('2026-08-01T02:59:59.999Z'),
      cutoffDate: null,
      totalHours: 5,
      totalAmount: new Prisma.Decimal('300'),
      currency: 'PYG',
      notes: null,
      closedAt: new Date('2026-07-31T00:00:00Z'),
      closedById: USER.id,
      sentAt: null,
      paidAt: null,
      createdAt: new Date('2026-07-31T00:00:00Z'),
      updatedAt: new Date('2026-07-31T00:00:00Z'),
      ...over,
    };
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    config = mockDeep<AppConfigService>();
    tx = mockDeep<Prisma.TransactionClient>();
    service = new ClientBillingService(prisma, audit, config);

    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, organizationId: ORG, currency: 'PYG' } as never);
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
    // H9a: computeFacturable hace un findMany EXTRA (revertidasVivas) después de candidatos y solo
    // si hay facturables. Los mockResolvedValueOnce de los stubs se consumen primero; esa llamada
    // extra cae en este fallback vacío (sin bloqueo) para no correr los índices de los stubs.
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);
  });

  // ── T17 + H8b — getBuilder: clasificación + workedMonth/atrasada ──────────
  describe('getBuilder', () => {
    // Orden de mocks: closedMonthKeys(cycle.findMany) → onTime(ht.findMany) → atrasadas(ht.findMany)
    //   → sinFechaTrabajo(ht.count) → cycles(cycle.findMany).
    function stubBuilder(onTime: unknown[], atrasadas: unknown[] = [], closedMonths: Date[] = []) {
      prisma.clientBillingCycle.findMany
        .mockResolvedValueOnce(closedMonths.map((d) => ({ periodStart: d })) as never) // closedMonthKeys
        .mockResolvedValueOnce([] as never); // cycles del período
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce(onTime as never) // on-time del mes
        .mockResolvedValueOnce(atrasadas as never); // atrasadas raw
      prisma.hoursTransaction.count.mockResolvedValue(0 as never); // sinFechaTrabajo
    }

    it('suma solo SUPPORT USAGE/LOAN con precio; PROJECT/INTERNAL/sinTarifa/REFUND excluidos; workedMonth seteado', async () => {
      stubBuilder([
        makeRow({ id: 's1', type: 'USAGE', taskType: 'SUPPORT', price: '100' }),
        makeRow({ id: 's2', type: 'LOAN', taskType: 'SUPPORT', price: '50' }),
        makeRow({ id: 's3', type: 'USAGE', taskType: 'SUPPORT', price: null }), // sinTarifa
        makeRow({ id: 'p1', type: 'USAGE', taskType: 'PROJECT', price: '200' }), // visible-only
        makeRow({ id: 'i1', type: 'INTERNAL', taskType: null, price: null }),
        makeRow({ id: 'r1', type: 'REFUND', taskType: null, price: null }),
      ]);

      const res = await service.getBuilder(ORG, CLIENT, '2026-07');

      expect(res.totalFacturable).toBe('150');
      expect(res.subtotalSoporte).toBe('150');
      expect(res.subtotalFueraCupo).toBe('50');
      expect(res.sinFechaTrabajo).toBe(0);
      expect(res.soporte.map((r) => r.id).sort()).toEqual(['s1', 's2', 's3']);
      expect(res.soporte.find((r) => r.id === 's2')?.fueraCupo).toBe(true);
      expect(res.soporte.find((r) => r.id === 's3')?.sinTarifa).toBe(true);
      expect(res.soporte.find((r) => r.id === 's1')?.workedMonth).toBe('2026-07'); // H8b
      expect(res.soporte.find((r) => r.id === 's1')?.atrasada).toBe(false);
      expect(res.proyecto.map((r) => r.id)).toEqual(['p1']);
      expect(res.interno.map((r) => r.id).sort()).toEqual(['i1', 'r1']);
    });

    it('H8b — atrasada de un mes YA CERRADO aparece en soporte tagueada atrasada + workedMonth previo', async () => {
      // onTime vacío; una atrasada de junio (mes cerrado).
      stubBuilder(
        [],
        [makeRow({ id: 'a1', type: 'USAGE', taskType: 'SUPPORT', price: '80', workedOn: new Date(Date.UTC(2026, 5, 28)) })],
        [new Date('2026-06-01T03:00:00Z')], // junio tiene ciclo activo → cerrado
      );

      const res = await service.getBuilder(ORG, CLIENT, '2026-07');

      const a1 = res.soporte.find((r) => r.id === 'a1');
      expect(a1).toBeDefined();
      expect(a1?.atrasada).toBe(true);
      expect(a1?.workedMonth).toBe('2026-06');
      expect(res.totalFacturable).toBe('80');
    });

    it('H8b — atrasada de un mes NUNCA cerrado NO aparece (no se barre; AC-11)', async () => {
      stubBuilder(
        [],
        [makeRow({ id: 'x1', type: 'USAGE', taskType: 'SUPPORT', price: '80', workedOn: new Date(Date.UTC(2026, 5, 28)) })],
        [], // ningún mes cerrado
      );

      const res = await service.getBuilder(ORG, CLIENT, '2026-07');

      expect(res.soporte.map((r) => r.id)).not.toContain('x1');
      expect(res.totalFacturable).toBe('0');
    });

    it('H8b — sinFechaTrabajo se propaga (integridad)', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never);
      prisma.hoursTransaction.count.mockResolvedValue(2 as never);

      const res = await service.getBuilder(ORG, CLIENT, '2026-07');
      expect(res.sinFechaTrabajo).toBe(2);
    });
  });

  // ── T18 + H8b — closeCycle: arrastre acotado, guards, cutoff ──────────────
  describe('closeCycle', () => {
    // closeCycle (antes del tx): clientBillingCycle.findMany(closedMonthKeys) + 3 hoursTransaction.findMany
    //   en orden: [0] guard R11 (sinTarifa), [1] guard workedOn-null, [2] candidatos.
    function stubClose(opts: {
      candidatos: Array<{ id: string; workedOn: Date | null }>;
      closedMonths?: Date[];
      sinTarifa?: Array<{ workedOn: Date | null }>;
      sinFecha?: Array<{ id: string }>;
      stampedCount?: number;
      sum?: string;
      hours?: number;
    }) {
      prisma.clientBillingCycle.findMany.mockResolvedValue(
        (opts.closedMonths ?? []).map((d) => ({ periodStart: d })) as never,
      );
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce((opts.sinTarifa ?? []) as never) // guard R11
        .mockResolvedValueOnce((opts.sinFecha ?? []) as never) // guard workedOn-null
        .mockResolvedValueOnce(opts.candidatos as never) // candidatos
        .mockResolvedValue([] as never); // H9a revertidasVivas (fallback vacío; cubre re-stubs post clearAllMocks)
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cyc1' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({
        count: opts.stampedCount ?? opts.candidatos.length,
      } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal(opts.sum ?? '300'), hours: opts.hours ?? 5 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);
    }

    const jul = (d: number) => new Date(Date.UTC(2026, 6, d));

    it('estampa por lista de ids on-time con candado billedCycleId:null + snapshot Decimal + cutoffDate', async () => {
      stubClose({ candidatos: [{ id: 'h1', workedOn: jul(10) }, { id: 'h2', workedOn: jul(11) }], sum: '300', hours: 5 });

      const res = await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      const updateArg = tx.hoursTransaction.updateMany.mock.calls[0][0];
      expect(updateArg.where).toMatchObject({ id: { in: ['h1', 'h2'] }, billedCycleId: null });
      // candidatos = 3er findMany, predicado facturable SUPPORT priced con workedOn (no createdAt).
      const candWhere = prisma.hoursTransaction.findMany.mock.calls[2][0]!.where as Record<string, unknown>;
      expect(candWhere).toMatchObject({
        clientId: CLIENT,
        deletedAt: null,
        billedCycleId: null,
        priceAmount: { not: null },
        task: { type: 'SUPPORT' },
      });
      expect(candWhere.type).toEqual({ in: ['USAGE', 'LOAN'] });
      expect(candWhere.workedOn).toHaveProperty('lte');
      // cutoffDate persistido en el create del ciclo (= periodEnd en cierre completo).
      const createData = tx.clientBillingCycle.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(createData.cutoffDate).toBeInstanceOf(Date);
      const snapData = tx.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect((snapData.totalAmount as Prisma.Decimal).toString()).toBe('300');
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.billing.cycle_closed' }),
      );
      expect(res.totalAmount).toBe('300');
      expect(res.movementCount).toBe(2);
    });

    it('H8b — corte parcial: candidatos y guard filtran por workedOn <= fecha Asunción de until (no createdAt)', async () => {
      stubClose({ candidatos: [{ id: 'h1', workedOn: jul(10) }], sum: '100', hours: 1 });
      const until = '2026-07-15T00:00:00.000Z'; // instante UTC → fecha Asunción = 2026-07-14

      await service.closeCycle(ORG, CLIENT, '2026-07', { until }, USER);

      // guard R11 = 1er findMany; candidatos = 3er. Ambos con workedOn.lte = 2026-07-14 (UTC-midnight).
      const guardWhere = prisma.hoursTransaction.findMany.mock.calls[0][0]!.where as { workedOn: { lte: Date } };
      const candWhere = prisma.hoursTransaction.findMany.mock.calls[2][0]!.where as { workedOn: { lte: Date } };
      expect(guardWhere.workedOn.lte.toISOString()).toBe('2026-07-14T00:00:00.000Z');
      expect(candWhere.workedOn.lte.toISOString()).toBe('2026-07-14T00:00:00.000Z');
    });

    it('H8b — arrastre acotado: agarra on-time de julio + atrasada de junio CERRADO; ignora mayo NUNCA cerrado', async () => {
      stubClose({
        candidatos: [
          { id: 'on', workedOn: jul(5) }, // on-time julio
          { id: 'jun', workedOn: new Date(Date.UTC(2026, 5, 20)) }, // atrasada junio (cerrado)
          { id: 'may', workedOn: new Date(Date.UTC(2026, 4, 20)) }, // mayo NUNCA cerrado
        ],
        closedMonths: [new Date('2026-06-01T03:00:00Z')], // solo junio cerrado
        sum: '300',
        hours: 5,
      });

      await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      const stampedIds = (tx.hoursTransaction.updateMany.mock.calls[0][0].where as { id: { in: string[] } }).id.in;
      expect(stampedIds.sort()).toEqual(['jun', 'on']); // 'may' excluido (mes nunca cerrado)
    });

    it('H8b — guard BILLABLE_WITHOUT_WORKED_ON: SUPPORT priced con workedOn null → 409, no abre tx', async () => {
      stubClose({ candidatos: [{ id: 'h1', workedOn: jul(10) }], sinFecha: [{ id: 'ghost' }] });

      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'BILLABLE_WITHOUT_WORKED_ON',
        statusCode: 409,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('H8b — R11 acotado: sin-tarifa de un mes CERRADO bloquea; de un mes NUNCA cerrado NO (AC-14)', async () => {
      // sin-tarifa de mayo (nunca cerrado) → inScope false → NO bloquea → cierra OK.
      stubClose({
        candidatos: [{ id: 'h1', workedOn: jul(10) }],
        sinTarifa: [{ workedOn: new Date(Date.UTC(2026, 4, 20)) }], // mayo, no cerrado
        closedMonths: [], // ningún mes cerrado
      });
      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).resolves.toBeDefined();

      jest.clearAllMocks();
      prisma.client.findFirst.mockResolvedValue({ id: CLIENT, organizationId: ORG, currency: 'PYG' } as never);
      prisma.$transaction.mockImplementation((cb: unknown) =>
        (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
      );
      // sin-tarifa de junio (cerrado) → inScope true → bloquea.
      stubClose({
        candidatos: [{ id: 'h1', workedOn: jul(10) }],
        sinTarifa: [{ workedOn: new Date(Date.UTC(2026, 5, 20)) }], // junio
        closedMonths: [new Date('2026-06-01T03:00:00Z')],
      });
      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'SUPPORT_RATE_NOT_CONFIGURED',
        statusCode: 409,
      });
    });

    it('NOTHING_TO_BILL 409 cuando el estampado cuenta 0 → no congela snapshot ni audita', async () => {
      stubClose({ candidatos: [{ id: 'h1', workedOn: jul(10) }], stampedCount: 0 });

      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'NOTHING_TO_BILL',
        statusCode: 409,
      });
      expect(tx.clientBillingCycle.update).not.toHaveBeenCalled();
      expect(audit.create).not.toHaveBeenCalled();
    });

    it('reintenta el P2002 del invoice_number POR FUERA del tx y luego cierra', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never) // guard R11
        .mockResolvedValueOnce([] as never) // guard null
        .mockResolvedValueOnce([{ id: 'h1', workedOn: jul(10) }] as never); // candidatos
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['organization_id', 'invoice_number'] },
      });
      tx.clientBillingCycle.create.mockRejectedValueOnce(p2002).mockResolvedValueOnce({ id: 'cyc1' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 1 } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal('100'), hours: 1 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);

      const res = await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      expect(tx.clientBillingCycle.create).toHaveBeenCalledTimes(2);
      expect(res.totalAmount).toBe('100');
    });

    it('SUPPORT_RATE_NOT_CONFIGURED 409 si hay soporte sin tarifar en el mes → no abre tx', async () => {
      stubClose({
        candidatos: [{ id: 'h1', workedOn: jul(10) }],
        sinTarifa: [{ workedOn: jul(9) }], // sin tarifa on-time del mes que se cierra
      });

      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'SUPPORT_RATE_NOT_CONFIGURED',
        statusCode: 409,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── H8d — previewCycle (dry-run) + emisión acumulada + numeración ────────
  describe('previewCycle + emisión H8d', () => {
    const d = (y: number, m0: number, day: number) => new Date(Date.UTC(y, m0, day));

    // Orden de queries de computeFacturable(MES): clientBillingCycle.findMany(closedMonthKeys) +
    //   3 hoursTransaction.findMany [0]sinTarifa [1]sinFecha [2]candidatos. Sin $transaction.
    function stubComputeMes(opts: {
      candidatos: unknown[];
      closedMonths?: Date[];
      sinTarifa?: Array<{ workedOn: Date | null }>;
      sinFecha?: Array<{ id: string }>;
    }) {
      prisma.clientBillingCycle.findMany.mockResolvedValue(
        (opts.closedMonths ?? []).map((dt) => ({ periodStart: dt })) as never,
      );
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce((opts.sinTarifa ?? []) as never)
        .mockResolvedValueOnce((opts.sinFecha ?? []) as never)
        .mockResolvedValueOnce(opts.candidatos as never);
    }

    it('AC-3/AC-4 — preview MES agrupa por workedMonth, subtotales string, puedeEmitir, sin escribir', async () => {
      stubComputeMes({
        candidatos: [
          makeRow({ id: 's1', type: 'USAGE', taskType: 'SUPPORT', price: '100' }),
          makeRow({ id: 's2', type: 'LOAN', taskType: 'SUPPORT', price: '50' }),
        ],
      });

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'MES', period: '2026-07' });

      expect(res.grupos).toHaveLength(1);
      expect(res.grupos[0].workedMonth).toBe('2026-07');
      expect(res.grupos[0].subtotalMes).toBe('150');
      expect(typeof res.grupos[0].subtotalMes).toBe('string');
      expect(res.grupos[0].horasMes).toBe(2);
      expect(res.total).toBe('150');
      expect(res.puedeEmitir).toBe(true);
      expect(res.motivo).toBeNull();
      // AC-1: dry-run no escribe.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.clientBillingCycle.create).not.toHaveBeenCalled();
    });

    it('AC-5 — preview ACUMULADO barre meses NUNCA cerrados (abril+mayo): 2 grupos ordenados, total = suma', async () => {
      // ACUMULADO no consulta closedMonthKeys: solo los 3 hoursTransaction.findMany.
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never) // sinTarifa
        .mockResolvedValueOnce([] as never) // sinFecha
        .mockResolvedValueOnce([
          makeRow({ id: 'may', type: 'USAGE', taskType: 'SUPPORT', price: '200', workedOn: d(2026, 4, 10) }),
          makeRow({ id: 'abr', type: 'USAGE', taskType: 'SUPPORT', price: '100', workedOn: d(2026, 3, 10) }),
        ] as never);

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'ACUMULADO', months: ['2026-04', '2026-05'] });

      expect(res.grupos.map((g) => g.workedMonth)).toEqual(['2026-04', '2026-05']); // cronológico
      expect(res.grupos[0].subtotalMes).toBe('100');
      expect(res.grupos[1].subtotalMes).toBe('200');
      expect(res.total).toBe('300');
      expect(res.puedeEmitir).toBe(true);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('AC-5 — ACUMULADO filtra por los meses ELEGIDOS: una fila de marzo (no elegido) NO entra', async () => {
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([
          makeRow({ id: 'mar', type: 'USAGE', taskType: 'SUPPORT', price: '999', workedOn: d(2026, 2, 10) }), // marzo
          makeRow({ id: 'abr', type: 'USAGE', taskType: 'SUPPORT', price: '100', workedOn: d(2026, 3, 10) }), // abril
        ] as never);

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'ACUMULADO', months: ['2026-04'] });

      expect(res.grupos.map((g) => g.workedMonth)).toEqual(['2026-04']);
      expect(res.total).toBe('100');
    });

    it('AC-13/AC-14 — preview expone bloqueos como flags (puedeEmitir false), SIN lanzar', async () => {
      stubComputeMes({
        candidatos: [makeRow({ id: 'h1', type: 'USAGE', taskType: 'SUPPORT', price: '100' })],
        sinTarifa: [{ workedOn: d(2026, 6, 9) }], // SUPPORT sin tarifa on-time julio → in scope
        sinFecha: [{ id: 'ghost' }],
      });

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'MES', period: '2026-07' });

      expect(res.bloqueos.sinTarifaRate).toBe(true);
      expect(res.bloqueos.sinFechaTrabajo).toEqual({ count: 1, ids: ['ghost'] });
      expect(res.puedeEmitir).toBe(false);
    });

    it('AC-12 — preview vacío → motivo NOTHING_TO_BILL, grupos [], total 0, puedeEmitir false', async () => {
      stubComputeMes({ candidatos: [] });

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'MES', period: '2026-07' });

      expect(res.grupos).toEqual([]);
      expect(res.total).toBe('0');
      expect(res.motivo).toBe('NOTHING_TO_BILL');
      expect(res.puedeEmitir).toBe(false);
    });

    it('AC-2/AC-8 — emisión ACUMULADA estampa kind=ACCUMULATED, periodStart=mes más viejo incluido, candado billedCycleId:null', async () => {
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never) // sinTarifa
        .mockResolvedValueOnce([] as never) // sinFecha
        .mockResolvedValueOnce([
          { id: 'abr', workedOn: d(2026, 3, 10) },
          { id: 'may', workedOn: d(2026, 4, 10) },
        ] as never); // candidatos
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cycA' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 2 } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal('300'), hours: 3 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);

      const res = await service.closeCycle(ORG, CLIENT, '', { mode: 'ACUMULADO', months: ['2026-04', '2026-05'] }, USER);

      const createData = tx.clientBillingCycle.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(createData.kind).toBe('ACCUMULATED');
      expect((createData.periodStart as Date).getUTCMonth()).toBe(3); // abril = mes más viejo del set
      expect(createData.cutoffDate).toBeInstanceOf(Date);
      const updateArg = tx.hoursTransaction.updateMany.mock.calls[0][0];
      expect(updateArg.where).toMatchObject({ id: { in: ['abr', 'may'] }, billedCycleId: null });
      expect(res.kind).toBe('ACCUMULATED');
    });

    it('AC-9 — numeración status-agnóstica: cuenta TODOS los ciclos del año (incl. anulados) → next = count+1', async () => {
      stubComputeMes({ candidatos: [{ id: 'h1', workedOn: d(2026, 6, 10) }] });
      tx.clientBillingCycle.count.mockResolvedValue(2 as never); // ya hay 2 (una puede estar anulada)
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cyc3' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 1 } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal('100'), hours: 1 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);

      await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      const createData = tx.clientBillingCycle.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(createData.invoiceNumber).toMatch(/^FAC-\d{4}-00003$/); // 2 + 1 = 00003 (sin reuso)
    });

    it('MONTHS_REQUIRED 400 si ACUMULADO sin meses', async () => {
      await expect(service.previewCycle(ORG, CLIENT, { mode: 'ACUMULADO', months: [] })).rejects.toMatchObject({
        code: 'MONTHS_REQUIRED',
        statusCode: 400,
      });
    });
  });

  // ── H9a — guard fail-closed (REFUND vivo apuntando a un candidato facturable) ──
  describe('H9a — guard fail-closed', () => {
    // Orden de queries de computeFacturable(MES): clientBillingCycle.findMany(closedMonthKeys) +
    //   4 hoursTransaction.findMany: [0] sinTarifa, [1] sinFecha, [2] candidatos, [3] revertidasVivas.
    function stubComputeConZombie() {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never); // closedMonthKeys
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never) // guard R11 (sinTarifa)
        .mockResolvedValueOnce([] as never) // guard workedOn-null
        .mockResolvedValueOnce([
          makeRow({ id: 'usage-zombie', type: 'USAGE', taskType: 'SUPPORT', price: '100' }),
        ] as never) // candidatos
        .mockResolvedValueOnce([{ reversesTransactionId: 'usage-zombie' }] as never); // H9a revertidasVivas
    }

    it('closeCycle lanza BILLABLE_INTEGRITY_VIOLATION 409 con los ids zombie → no abre tx', async () => {
      stubComputeConZombie();

      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'BILLABLE_INTEGRITY_VIOLATION',
        statusCode: 409,
        details: { ids: ['usage-zombie'] },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('previewCycle con REFUND vivo sobre candidato → bloqueo revertidasVivas y puedeEmitir false, SIN lanzar', async () => {
      stubComputeConZombie();

      const res = await service.previewCycle(ORG, CLIENT, { mode: 'MES', period: '2026-07' });

      expect(res.bloqueos.revertidasVivas).toEqual({ count: 1, ids: ['usage-zombie'] });
      expect(res.puedeEmitir).toBe(false);
    });
  });

  // ── T19 — estados / reopen (R7, R8) ─────────────────────────────────────
  describe('updateCycle', () => {
    it('DRAFT→SENT sella sentAt', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);
      prisma.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);

      await service.updateCycle(ORG, CLIENT, 'cyc1', { status: 'SENT' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('SENT');
      expect(data.sentAt).toBeInstanceOf(Date);
    });

    it('transición ilegal DRAFT→PAID → 409 sin actualizar', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);

      await expect(service.updateCycle(ORG, CLIENT, 'cyc1', { status: 'PAID' }, USER)).rejects.toMatchObject({
        code: 'INVALID_CYCLE_TRANSITION',
        statusCode: 409,
      });
      expect(prisma.clientBillingCycle.update).not.toHaveBeenCalled();
    });
  });

  describe('reopenCycle', () => {
    it('H8d/A3 — anula con motivo: libera estampados + CANCELLED + sella cancelReason/cancelledAt/cancelledById + audita', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 3 } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'CANCELLED' }) as never);

      const res = await service.reopenCycle(ORG, CLIENT, 'cyc1', { cancelReason: 'Error de carga' }, USER);

      expect(tx.hoursTransaction.updateMany).toHaveBeenCalledWith({
        where: { billedCycleId: 'cyc1' },
        data: { billedCycleId: null },
      });
      const updateData = tx.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(updateData.status).toBe('CANCELLED');
      expect(updateData.cancelReason).toBe('Error de carga');
      expect(updateData.cancelledAt).toBeInstanceOf(Date);
      expect(updateData.cancelledById).toBe(USER.id);
      expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'client.billing.cycle_reopened' }));
      expect(res.releasedCount).toBe(3);
    });

    it('reopen de PAID → 409 CYCLE_ALREADY_PAID sin liberar', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'PAID' }) as never);

      await expect(
        service.reopenCycle(ORG, CLIENT, 'cyc1', { cancelReason: 'no aplica' }, USER),
      ).rejects.toMatchObject({
        code: 'CYCLE_ALREADY_PAID',
        statusCode: 409,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── T6 / R1 + H8b — listCycles: bucketing por workedMonth ────────────────
  describe('listCycles', () => {
    const PAST = new Date(Date.UTC(2020, 2, 15)); // 2020-03 (workedMonthKey)

    // Fila facturable con el select de listCycles ({ workedOn, priceAmount, billedCycleId }).
    function facRow(workedOn: Date | null, price: string | null, billedCycleId: string | null) {
      return { workedOn, priceAmount: price != null ? new Prisma.Decimal(price) : null, billedCycleId };
    }

    // Día calendario Asunción de hoy, como UTC-midnight → workedMonthKey == currentKey del service.
    function currentWorked(): Date {
      const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Asuncion',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date())
        .split('-')
        .map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    }

    it('AC1: el mes actual → EN_CURSO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(currentWorked(), '100', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('EN_CURSO');
      expect(res[0].totalFacturable).toBe('100');
    });

    it('AC2: mes pasado con facturable sin estampar y sin ciclo → NO_FACTURADO (bucket por workedMonth)', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '250', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res).toHaveLength(1);
      expect(res[0].period).toBe('2020-03');
      expect(res[0].estado).toBe('NO_FACTURADO');
      expect(res[0].totalFacturable).toBe('250');
    });

    it('AC3: mes con ciclo activo + remanente sin estampar → FACTURADO_PARCIAL', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'DRAFT', periodStart: new Date(Date.UTC(2020, 2, 1, 3)) }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([
        facRow(PAST, '300', 'cyc1'),
        facRow(PAST, '100', null),
      ] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res[0].estado).toBe('FACTURADO_PARCIAL');
      expect(res[0].totalFacturable).toBe('100');
    });

    it('H8b — fila con workedOn null se saltea del bucketing (no rompe)', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([
        facRow(null, '999', null), // sin fecha → no bucketea
        facRow(PAST, '100', null),
      ] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res).toHaveLength(1);
      expect(res[0].period).toBe('2020-03');
      expect(res[0].totalFacturable).toBe('100'); // la de 999 no cuenta
    });

    it('AC4: mes con ciclo y sin remanente → FACTURADO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'PAID', periodStart: new Date(Date.UTC(2020, 2, 1, 3)) }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '300', 'cyc1')] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res[0].estado).toBe('FACTURADO');
      expect(res[0].totalFacturable).toBe('0');
    });

    it('AC5: mes con ciclo pero sin filas facturables bucketeadas → SIN_TRABAJO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'DRAFT', periodStart: new Date(Date.UTC(2020, 2, 1, 3)) }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res[0].estado).toBe('SIN_TRABAJO');
      expect(res[0].totalFacturable).toBe('0');
    });

    it('un ciclo CANCELLED NO cuenta como activo → NO_FACTURADO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'CANCELLED', periodStart: new Date(Date.UTC(2020, 2, 1, 3)) }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '150', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);
      expect(res[0].estado).toBe('NO_FACTURADO');
      expect(res[0].totalFacturable).toBe('150');
    });
  });

  // ── T24 + H8b — getCycleTransactions: líneas con workedOn/workedMonth ─────
  describe('getCycleTransactions', () => {
    it('devuelve líneas con workedOn/workedMonth/atrasada + montos string, ordenadas por workedOn', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([
        {
          id: 'h1',
          createdAt: new Date('2026-07-10T12:00:00Z'),
          workedOn: new Date(Date.UTC(2026, 5, 28)), // junio → atrasada (ciclo es julio)
          type: 'USAGE',
          hours: 2,
          note: 'n1',
          priceAmount: new Prisma.Decimal('200'),
          priceCurrency: 'PYG',
          task: { id: 't1', title: 'Soporte X', type: 'SUPPORT' },
        },
      ] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, 'cyc1');

      expect(res.cycle.id).toBe('cyc1');
      expect(res.transactions[0].priceAmount).toBe('200');
      expect(res.transactions[0].workedMonth).toBe('2026-06');
      expect(res.transactions[0].atrasada).toBe(true); // ciclo julio, línea junio
      expect(prisma.hoursTransaction.findMany.mock.calls[0][0]!.orderBy).toEqual({ workedOn: 'asc' });
    });

    it('ciclo inexistente → 404 CYCLE_NOT_FOUND', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(null as never);
      await expect(service.getCycleTransactions(ORG, CLIENT, 'nope')).rejects.toMatchObject({
        code: 'CYCLE_NOT_FOUND',
        statusCode: 404,
      });
    });
  });

  // ── R13 — scope multi-tenant ────────────────────────────────────────────
  describe('assertClient (scope R13)', () => {
    it('clientId fuera de la org → 404 CLIENT_NOT_FOUND', async () => {
      prisma.client.findFirst.mockResolvedValue(null as never);
      await expect(service.listCycles(ORG, 'other-client')).rejects.toMatchObject({
        code: 'CLIENT_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.client.findFirst.mock.calls[0][0]!.where).toMatchObject({ id: 'other-client', organizationId: ORG });
    });
  });

  // ── H9b — Notas de crédito ───────────────────────────────────────────────
  describe('emit/preview credit note (H9b)', () => {
    // Fila original estampada (con task.title), como la devuelve resolveCreditNoteLines.
    function makeOriginal(opts: {
      id: string;
      type?: string;
      hours?: number;
      price?: string;
      workedOn?: Date;
      taskId?: string;
      title?: string;
    }) {
      return {
        id: opts.id,
        type: opts.type ?? 'USAGE',
        hours: opts.hours ?? 2,
        taskId: opts.taskId ?? `task-${opts.id}`,
        note: `note-${opts.id}`,
        priceAmount: new Prisma.Decimal(opts.price ?? '100'),
        priceRate: new Prisma.Decimal('50'),
        priceCurrency: 'PYG',
        workedOn: opts.workedOn ?? new Date(Date.UTC(2026, 6, 10)),
        task: { title: opts.title ?? `Task ${opts.id}` },
      };
    }

    beforeEach(() => {
      // pre-check I1: por defecto ninguna línea acreditada previamente.
      prisma.creditNoteLine.findMany.mockResolvedValue([] as never);
    });

    it('emit ON: crea CreditNote + N líneas congeladas (positivo) + N espejos (billedCycleId/timeEntryId/entryVersion sin setear, rebilled=orig, workedOn copiado); totales NEGATIVOS + audit', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([
        makeOriginal({ id: 'o1', price: '100', hours: 2 }),
        makeOriginal({ id: 'o2', price: '50', hours: 1 }),
      ] as never);
      tx.creditNote.count.mockResolvedValue(0 as never);
      tx.creditNote.create.mockResolvedValue({
        id: 'nc1',
        totalAmount: new Prisma.Decimal('-150'),
        totalHours: -3,
      } as never);
      tx.creditNoteLine.create.mockResolvedValue({} as never);
      tx.hoursTransaction.create.mockResolvedValue({} as never);

      const res = await service.emitCreditNote(
        ORG,
        CLIENT,
        'cyc1',
        { lineIds: ['o1', 'o2'], reason: 'Tarifa equivocada', returnHoursToBillable: true },
        USER,
      );

      // Header: número NC aislado + totales NEGATIVOS.
      const ncData = tx.creditNote.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(ncData.number).toMatch(/^NC-\d{4}-00001$/);
      expect((ncData.totalAmount as Prisma.Decimal).toString()).toBe('-150');
      expect(ncData.totalHours).toBe(-3);
      expect(ncData.returnHoursToBillable).toBe(true);
      expect(ncData.appliesToCycleId).toBe('cyc1');

      // 2 líneas congeladas con montos POSITIVOS (snapshot fiel).
      expect(tx.creditNoteLine.create).toHaveBeenCalledTimes(2);
      const line0 = tx.creditNoteLine.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(line0.creditedTransactionId).toBe('o1');
      expect((line0.priceAmount as Prisma.Decimal).toString()).toBe('100');
      expect(line0.description).toBe('Task o1');

      // 2 espejos facturables: no tocan cupo ni estampan; linaje al original.
      expect(tx.hoursTransaction.create).toHaveBeenCalledTimes(2);
      const mirror0 = tx.hoursTransaction.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(mirror0.billedCycleId).toBeUndefined();
      expect(mirror0.timeEntryId).toBeUndefined();
      expect(mirror0.entryVersion).toBeUndefined();
      expect(mirror0.rebilledFromTransactionId).toBe('o1');
      expect(mirror0.workedOn).toEqual(new Date(Date.UTC(2026, 6, 10)));
      expect(mirror0.type).toBe('USAGE');

      expect(res.totalAmount).toBe('-150');
      expect(res.lineCount).toBe(2);
      expect(res.returnHoursToBillable).toBe(true);
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.billing.credit_note_issued' }),
      );
    });

    it('emit OFF: crea líneas pero SIN espejos', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'PAID' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([makeOriginal({ id: 'o1', price: '100' })] as never);
      tx.creditNote.count.mockResolvedValue(0 as never);
      tx.creditNote.create.mockResolvedValue({
        id: 'nc1',
        totalAmount: new Prisma.Decimal('-100'),
        totalHours: -2,
      } as never);
      tx.creditNoteLine.create.mockResolvedValue({} as never);

      await service.emitCreditNote(
        ORG,
        CLIENT,
        'cyc1',
        { lineIds: ['o1'], reason: 'Gesto comercial', returnHoursToBillable: false },
        USER,
      );

      expect(tx.creditNoteLine.create).toHaveBeenCalledTimes(1);
      expect(tx.hoursTransaction.create).not.toHaveBeenCalled();
    });

    it('numeración count-in-tx: number = NC-YYYY-(count+1)', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([makeOriginal({ id: 'o1', price: '100' })] as never);
      tx.creditNote.count.mockResolvedValue(4 as never); // ya hay 4 NC este año
      tx.creditNote.create.mockResolvedValue({
        id: 'nc5',
        totalAmount: new Prisma.Decimal('-100'),
        totalHours: -2,
      } as never);
      tx.creditNoteLine.create.mockResolvedValue({} as never);
      tx.hoursTransaction.create.mockResolvedValue({} as never);

      await service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1'], reason: 'motivo' }, USER);

      const ncData = tx.creditNote.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(ncData.number).toMatch(/^NC-\d{4}-00005$/);
    });

    it('guard I3: NC sobre factura DRAFT → 409 CREDIT_NOTE_INVALID_INVOICE_STATE, no abre tx', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);

      await expect(
        service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1'], reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'CREDIT_NOTE_INVALID_INVOICE_STATE', statusCode: 409 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guard: NC sobre factura CANCELLED → 409 CREDIT_NOTE_INVALID_INVOICE_STATE', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'CANCELLED' }) as never);

      await expect(
        service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1'], reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'CREDIT_NOTE_INVALID_INVOICE_STATE', statusCode: 409 });
    });

    it('ciclo inexistente → 404 CYCLE_NOT_FOUND', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(null as never);
      await expect(
        service.emitCreditNote(ORG, CLIENT, 'nope', { lineIds: ['o1'], reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'CYCLE_NOT_FOUND', statusCode: 404 });
    });

    it('línea que no pertenece a la FAC / no acreditable → 400 CREDIT_NOTE_INVALID_LINE', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      // pide 2, resuelve 1 → mismatch.
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([makeOriginal({ id: 'o1' })] as never);

      await expect(
        service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1', 'o2'], reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'CREDIT_NOTE_INVALID_LINE', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('pre-check I1: línea ya acreditada → 409 LINE_ALREADY_CREDITED con los ids', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([makeOriginal({ id: 'o1' })] as never);
      prisma.creditNoteLine.findMany.mockResolvedValue([{ creditedTransactionId: 'o1' }] as never);

      await expect(
        service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1'], reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'LINE_ALREADY_CREDITED', statusCode: 409, details: { ids: ['o1'] } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reintenta el P2002 del número de NC (isCreditNoteNumberConflict) y luego emite', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([makeOriginal({ id: 'o1', price: '100', hours: 2 })] as never);
      tx.creditNote.count.mockResolvedValue(0 as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: 'credit_notes_organization_id_number_key' },
      });
      tx.creditNote.create
        .mockRejectedValueOnce(p2002)
        .mockResolvedValueOnce({ id: 'nc1', totalAmount: new Prisma.Decimal('-100'), totalHours: -2 } as never);
      tx.creditNoteLine.create.mockResolvedValue({} as never);
      tx.hoursTransaction.create.mockResolvedValue({} as never);

      const res = await service.emitCreditNote(
        ORG,
        CLIENT,
        'cyc1',
        { lineIds: ['o1'], reason: 'motivo', returnHoursToBillable: true },
        USER,
      );

      expect(tx.creditNote.create).toHaveBeenCalledTimes(2);
      expect(res.number).toMatch(/^NC-\d{4}-00001$/);
    });

    it('reintenta el P2002 del número de NC también cuando meta.target es ARRAY de columnas', async () => {
      // Postgres/Prisma puede devolver meta.target como array (['organization_id','number']) en vez del
      // nombre del índice — el detector debe reconocerlo en AMBOS shapes (regresión: antes exigía 'credit').
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([makeOriginal({ id: 'o1', price: '100', hours: 2 })] as never);
      tx.creditNote.count.mockResolvedValue(0 as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['organization_id', 'number'] },
      });
      tx.creditNote.create
        .mockRejectedValueOnce(p2002)
        .mockResolvedValueOnce({ id: 'nc1', totalAmount: new Prisma.Decimal('-100'), totalHours: -2 } as never);
      tx.creditNoteLine.create.mockResolvedValue({} as never);
      tx.hoursTransaction.create.mockResolvedValue({} as never);

      const res = await service.emitCreditNote(
        ORG,
        CLIENT,
        'cyc1',
        { lineIds: ['o1'], reason: 'motivo', returnHoursToBillable: true },
        USER,
      );

      expect(tx.creditNote.create).toHaveBeenCalledTimes(2);
      expect(res.number).toMatch(/^NC-\d{4}-00001$/);
    });

    it('exige motivo de al menos 3 caracteres EFECTIVOS (post-trim) → 400 CREDIT_NOTE_REASON_REQUIRED', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([makeOriginal({ id: 'o1' })] as never);

      await expect(
        service.emitCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1'], reason: ' a ' }, USER),
      ).rejects.toMatchObject({ code: 'CREDIT_NOTE_REASON_REQUIRED', statusCode: 400 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('P2002 de línea ya acreditada bajo carrera (isLineAlreadyCreditedConflict) → 409 LINE_ALREADY_CREDITED sin retry', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([makeOriginal({ id: 'o1' })] as never);
      tx.creditNote.count.mockResolvedValue(0 as never);
      tx.creditNote.create.mockResolvedValue({
        id: 'nc1',
        totalAmount: new Prisma.Decimal('-100'),
        totalHours: -2,
      } as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: 'credit_note_lines_credited_transaction_id_key' },
      });
      tx.creditNoteLine.create.mockRejectedValue(p2002);

      await expect(
        service.emitCreditNote(
          ORG,
          CLIENT,
          'cyc1',
          { lineIds: ['o1'], reason: 'motivo', returnHoursToBillable: false },
          USER,
        ),
      ).rejects.toMatchObject({ code: 'LINE_ALREADY_CREDITED', statusCode: 409 });
      expect(tx.creditNote.create).toHaveBeenCalledTimes(1); // sin retry
    });

    it('previewCreditNote: dry-run con totales NEGATIVOS + detalle POSITIVO, sin escribir', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ status: 'SENT', invoiceNumber: 'FAC-2026-00009', currency: 'PYG' }) as never,
      );
      prisma.hoursTransaction.findMany.mockResolvedValueOnce([
        makeOriginal({ id: 'o1', price: '100', hours: 2, title: 'Ajuste' }),
        makeOriginal({ id: 'o2', price: '50', hours: 1 }),
      ] as never);

      const res = await service.previewCreditNote(ORG, CLIENT, 'cyc1', { lineIds: ['o1', 'o2'], reason: 'x' });

      expect(res.totalAmount).toBe('-150');
      expect(res.totalHours).toBe(-3);
      expect(res.lineCount).toBe(2);
      expect(res.invoiceNumber).toBe('FAC-2026-00009');
      expect(res.lines[0].priceAmount).toBe('100'); // detalle en positivo
      expect(res.lines[0].description).toBe('Ajuste');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('D1 — getClosedMonthKeys cubre el RANGO [periodStart..periodEnd]: un mes intermedio de una ACUMULADA queda cerrado', async () => {
      // Ciclo ACUMULADO cerrado que cubre mayo→julio (periodStart mayo, periodEnd fin de julio).
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        { periodStart: new Date('2026-05-01T03:00:00Z'), periodEnd: new Date('2026-08-01T02:59:59.999Z') },
      ] as never);
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never) // sinTarifa
        .mockResolvedValueOnce([] as never) // sinFecha
        .mockResolvedValueOnce([{ id: 'jun', workedOn: new Date(Date.UTC(2026, 5, 15)) }] as never); // candidato junio (mid-range)
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cyc9' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 1 } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal('100'), hours: 1 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);

      // Cierra agosto: junio (mes intermedio de la acumulada) debe entrar por el rango D1.
      await service.closeCycle(ORG, CLIENT, '2026-08', {}, USER);

      const stampedIds = (tx.hoursTransaction.updateMany.mock.calls[0][0].where as { id: { in: string[] } }).id.in;
      expect(stampedIds).toContain('jun');
    });
  });

  describe('reopenCycle con NC (H9b)', () => {
    it('anular una FAC con notas de crédito → 409 CYCLE_HAS_CREDIT_NOTES sin liberar', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.creditNote.count.mockResolvedValue(1 as never);

      await expect(
        service.reopenCycle(ORG, CLIENT, 'cyc1', { cancelReason: 'no aplica' }, USER),
      ).rejects.toMatchObject({ code: 'CYCLE_HAS_CREDIT_NOTES', statusCode: 409 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
