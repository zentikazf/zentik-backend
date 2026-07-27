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
        .mockResolvedValueOnce(opts.candidatos as never); // candidatos
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
    it('libera estampados (billedCycleId=null) + CANCELLED + audita', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 3 } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'CANCELLED' }) as never);

      const res = await service.reopenCycle(ORG, CLIENT, 'cyc1', USER);

      expect(tx.hoursTransaction.updateMany).toHaveBeenCalledWith({
        where: { billedCycleId: 'cyc1' },
        data: { billedCycleId: null },
      });
      expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'client.billing.cycle_reopened' }));
      expect(res.releasedCount).toBe(3);
    });

    it('reopen de PAID → 409 CYCLE_ALREADY_PAID sin liberar', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'PAID' }) as never);

      await expect(service.reopenCycle(ORG, CLIENT, 'cyc1', USER)).rejects.toMatchObject({
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
});
