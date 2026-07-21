import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientBillingService } from '../client-billing.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppConfigService } from '../../../config/app.config';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

/**
 * Tests unitarios del cierre de ciclo de facturación (feature #25).
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod). El
 * tx-mock está HOISTEADO al describe para inspeccionar sus llamadas (§1.10). El
 * rollback/idempotencia se prueban POR SEMÁNTICA (rejects + snapshot-update NO
 * llamado + audit NO llamado); el rollback real lo verifica el E2E del dev (L1).
 */
describe('ClientBillingService (#25)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let config: DeepMockProxy<AppConfigService>;
  let tx: DeepMockProxy<Prisma.TransactionClient>;
  let service: ClientBillingService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';
  const USER = { id: 'user-1', email: 'u@e.com', name: 'U' } as AuthenticatedUser;

  function makeRow(opts: {
    id: string;
    type: string;
    taskType: string | null;
    price: string | null;
    hours?: number;
  }) {
    return {
      id: opts.id,
      type: opts.type,
      hours: opts.hours ?? 1,
      note: `note-${opts.id}`,
      createdAt: new Date('2026-07-10T12:00:00Z'),
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

    // assertClient por defecto → cliente válido de la org.
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, organizationId: ORG, currency: 'PYG' } as never);

    // $transaction interactivo: ejecuta el callback con el tx hoisteado (cast a unknown OBLIGATORIO).
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
  });

  // ── T17 — getBuilder: cálculo / clasificación (R2, R3, R11 AC1) ──────────
  describe('getBuilder', () => {
    it('suma solo SUPPORT USAGE/LOAN con precio; PROJECT/INTERNAL/sinTarifa/REFUND excluidos', async () => {
      prisma.hoursTransaction.findMany.mockResolvedValue([
        makeRow({ id: 's1', type: 'USAGE', taskType: 'SUPPORT', price: '100' }),
        makeRow({ id: 's2', type: 'LOAN', taskType: 'SUPPORT', price: '50' }),
        makeRow({ id: 's3', type: 'USAGE', taskType: 'SUPPORT', price: null }), // sinTarifa
        makeRow({ id: 'p1', type: 'USAGE', taskType: 'PROJECT', price: '200' }), // visible-only
        makeRow({ id: 'i1', type: 'INTERNAL', taskType: null, price: null }),
        makeRow({ id: 'r1', type: 'REFUND', taskType: null, price: null }),
      ] as never);
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);

      const res = await service.getBuilder(ORG, CLIENT, '2026-07');

      expect(res.totalFacturable).toBe('150');
      expect(res.subtotalSoporte).toBe('150');
      expect(res.subtotalFueraCupo).toBe('50');
      expect(res.currency).toBe('PYG');
      // soporte incluye s1 (billable), s2 (fueraCupo), s3 (sinTarifa, no sumable).
      expect(res.soporte.map((r) => r.id).sort()).toEqual(['s1', 's2', 's3']);
      expect(res.soporte.find((r) => r.id === 's2')?.fueraCupo).toBe(true);
      expect(res.soporte.find((r) => r.id === 's3')?.sinTarifa).toBe(true);
      expect(res.soporte.find((r) => r.id === 's3')?.billable).toBe(false);
      expect(res.proyecto.map((r) => r.id)).toEqual(['p1']);
      expect(res.proyecto[0].billable).toBe(false);
      expect(res.interno.map((r) => r.id).sort()).toEqual(['i1', 'r1']);
    });
  });

  // ── T18 — closeCycle: idempotencia / cierre (R4, R5, R6, R14) ────────────
  describe('closeCycle', () => {
    function stubHappy(count = 2, sum = '300', hours = 5) {
      prisma.hoursTransaction.count.mockResolvedValue(0 as never); // guard R11 OK
      prisma.hoursTransaction.findMany.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({ id: `h${i + 1}` })) as never,
      );
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cyc1' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal(sum), hours },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);
    }

    it('estampa por lista de ids con candado billedCycleId:null y congela el snapshot Decimal', async () => {
      stubHappy(2, '300', 5);

      const res = await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      // §1.2 — estampado por id list + candado.
      const updateArg = tx.hoursTransaction.updateMany.mock.calls[0][0];
      expect(updateArg.where).toMatchObject({ id: { in: ['h1', 'h2'] }, billedCycleId: null });
      // resolve-ids llevó el predicado facturable completo.
      const findWhere = prisma.hoursTransaction.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
      expect(findWhere).toMatchObject({
        clientId: CLIENT,
        deletedAt: null,
        billedCycleId: null,
        priceAmount: { not: null },
        task: { type: 'SUPPORT' },
      });
      expect(findWhere.type).toEqual({ in: ['USAGE', 'LOAN'] });
      // §1.4 — snapshot Decimal directo del aggregate.
      const snapData = tx.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect((snapData.totalAmount as Prisma.Decimal).toString()).toBe('300');
      expect(snapData.totalHours).toBe(5);
      // R12 — audit del cierre.
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.billing.cycle_closed', resource: 'client', resourceId: CLIENT }),
      );
      expect(res.totalAmount).toBe('300');
      expect(res.movementCount).toBe(2);
    });

    it('corte parcial: estampa/cuenta solo createdAt <= until (R6)', async () => {
      stubHappy(1, '100', 1);
      const until = '2026-07-15T00:00:00.000Z';

      await service.closeCycle(ORG, CLIENT, '2026-07', { until }, USER);

      const findWhere = prisma.hoursTransaction.findMany.mock.calls[0][0]!.where as {
        createdAt: { lte: Date };
      };
      expect((findWhere.createdAt.lte as Date).toISOString()).toBe(until);
      const guardWhere = prisma.hoursTransaction.count.mock.calls[0][0]!.where as {
        createdAt: { lte: Date };
      };
      expect((guardWhere.createdAt.lte as Date).toISOString()).toBe(until);
    });

    it('NOTHING_TO_BILL 409 cuando el estampado cuenta 0 → no congela snapshot ni audita (R5 AC3)', async () => {
      prisma.hoursTransaction.count.mockResolvedValue(0 as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([{ id: 'h1' }] as never);
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      tx.clientBillingCycle.create.mockResolvedValue({ id: 'cyc1' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 0 } as never);

      await expect(service.closeCycle(ORG, CLIENT, '2026-07', {}, USER)).rejects.toMatchObject({
        code: 'NOTHING_TO_BILL',
        statusCode: 409,
      });
      expect(tx.clientBillingCycle.update).not.toHaveBeenCalled();
      expect(audit.create).not.toHaveBeenCalled();
    });

    it('reintenta el P2002 del invoice_number POR FUERA del tx y luego cierra (§1.3)', async () => {
      prisma.hoursTransaction.count.mockResolvedValue(0 as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([{ id: 'h1' }] as never);
      tx.clientBillingCycle.count.mockResolvedValue(0 as never);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['organization_id', 'invoice_number'] },
      });
      tx.clientBillingCycle.create
        .mockRejectedValueOnce(p2002)
        .mockResolvedValueOnce({ id: 'cyc1' } as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 1 } as never);
      tx.hoursTransaction.aggregate.mockResolvedValue({
        _sum: { priceAmount: new Prisma.Decimal('100'), hours: 1 },
      } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle() as never);

      const res = await service.closeCycle(ORG, CLIENT, '2026-07', {}, USER);

      expect(tx.clientBillingCycle.create).toHaveBeenCalledTimes(2);
      expect(res.totalAmount).toBe('100');
    });

    it('SUPPORT_RATE_NOT_CONFIGURED 409 si hay soporte sin tarifar → no abre tx (R11)', async () => {
      prisma.hoursTransaction.count.mockResolvedValue(2 as never);

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

    it('SENT→PAID sella paidAt', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'PAID' }) as never);

      await service.updateCycle(ORG, CLIENT, 'cyc1', { status: 'PAID' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('PAID');
      expect(data.paidAt).toBeInstanceOf(Date);
    });

    it('transición ilegal DRAFT→PAID → 409 INVALID_CYCLE_TRANSITION sin actualizar', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);

      await expect(service.updateCycle(ORG, CLIENT, 'cyc1', { status: 'PAID' }, USER)).rejects.toMatchObject({
        code: 'INVALID_CYCLE_TRANSITION',
        statusCode: 409,
      });
      expect(prisma.clientBillingCycle.update).not.toHaveBeenCalled();
    });
  });

  describe('reopenCycle', () => {
    it('libera estampados (billedCycleId=null) + CANCELLED + audita (R8 AC1, R12)', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);
      tx.hoursTransaction.updateMany.mockResolvedValue({ count: 3 } as never);
      tx.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'CANCELLED' }) as never);

      const res = await service.reopenCycle(ORG, CLIENT, 'cyc1', USER);

      expect(tx.hoursTransaction.updateMany).toHaveBeenCalledWith({
        where: { billedCycleId: 'cyc1' },
        data: { billedCycleId: null },
      });
      const upd = tx.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(upd.status).toBe('CANCELLED');
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'client.billing.cycle_reopened' }),
      );
      expect(res.releasedCount).toBe(3);
    });

    it('reopen de PAID → 409 CYCLE_ALREADY_PAID sin liberar (R8 AC2)', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'PAID' }) as never);

      await expect(service.reopenCycle(ORG, CLIENT, 'cyc1', USER)).rejects.toMatchObject({
        code: 'CYCLE_ALREADY_PAID',
        statusCode: 409,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── T6 / R1 — listCycles: derivación de estado por mes (5 ACs + CANCELLED) ─
  describe('listCycles', () => {
    // Mes pasado inequívoco (mediodía UTC → mismo mes en Asunción con cualquier offset).
    const PAST = new Date('2020-03-15T12:00:00Z');

    // Fila facturable minimalista con el select de listCycles ({ createdAt, priceAmount, billedCycleId }).
    function facRow(createdAt: Date, price: string | null, billedCycleId: string | null) {
      return {
        createdAt,
        priceAmount: price != null ? new Prisma.Decimal(price) : null,
        billedCycleId,
      };
    }

    it('AC1: el mes actual → EN_CURSO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(new Date(), '100', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('EN_CURSO');
      expect(res[0].totalFacturable).toBe('100');
    });

    it('AC2: mes pasado con facturable sin estampar y sin ciclo → NO_FACTURADO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '250', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('NO_FACTURADO');
      expect(res[0].totalFacturable).toBe('250');
    });

    it('AC3: mes con ciclo activo + remanente sin estampar → FACTURADO_PARCIAL (remanente Decimal)', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'DRAFT', periodStart: PAST }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([
        facRow(PAST, '300', 'cyc1'), // ya estampada → no cuenta al remanente
        facRow(PAST, '100', null), // remanente
      ] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('FACTURADO_PARCIAL');
      expect(res[0].totalFacturable).toBe('100');
    });

    it('AC4: mes con ciclo y sin remanente → FACTURADO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'PAID', periodStart: PAST }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '300', 'cyc1')] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('FACTURADO');
      expect(res[0].totalFacturable).toBe('0');
    });

    it('AC5: mes sin filas facturables → SIN_TRABAJO y totalFacturable "0"', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'DRAFT', periodStart: PAST }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('SIN_TRABAJO');
      expect(res[0].totalFacturable).toBe('0');
    });

    it('un ciclo CANCELLED NO cuenta como activo → el mes vuelve a NO_FACTURADO', async () => {
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        makeCycle({ status: 'CANCELLED', periodStart: PAST }),
      ] as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([facRow(PAST, '150', null)] as never);

      const res = await service.listCycles(ORG, CLIENT);

      expect(res).toHaveLength(1);
      expect(res[0].estado).toBe('NO_FACTURADO');
      expect(res[0].totalFacturable).toBe('150');
    });
  });

  // ── T24 / R1·R4 — getCycleTransactions: líneas facturadas del snapshot ───
  describe('getCycleTransactions', () => {
    it('devuelve { cycle, transactions } scopeado por ciclo, con montos como string', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([
        {
          id: 'h1',
          createdAt: new Date('2026-07-10T12:00:00Z'),
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
      expect(res.cycle.totalAmount).toBe('300'); // Decimal → string, sin desenvolver
      expect(res.transactions).toHaveLength(1);
      expect(res.transactions[0].priceAmount).toBe('200'); // Decimal → string
      expect(res.transactions[0].task).toEqual({ id: 't1', title: 'Soporte X', type: 'SUPPORT' });
      // scope: solo filas estampadas con billedCycleId del ciclo.
      expect(prisma.hoursTransaction.findMany.mock.calls[0][0]!.where).toMatchObject({ billedCycleId: 'cyc1' });
    });

    it('ciclo inexistente / fuera de scope → 404 CYCLE_NOT_FOUND (no lista transacciones)', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(null as never);

      await expect(service.getCycleTransactions(ORG, CLIENT, 'nope')).rejects.toMatchObject({
        code: 'CYCLE_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.hoursTransaction.findMany).not.toHaveBeenCalled();
    });

    it('cliente fuera de la org → 404 CLIENT_NOT_FOUND antes de cargar el ciclo', async () => {
      prisma.client.findFirst.mockResolvedValue(null as never);

      await expect(service.getCycleTransactions(ORG, 'other-client', 'cyc1')).rejects.toMatchObject({
        code: 'CLIENT_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.clientBillingCycle.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── R13 AC1 — scope multi-tenant por recurso ────────────────────────────
  describe('assertClient (scope R13)', () => {
    it('clientId fuera de la org → 404 CLIENT_NOT_FOUND, con organizationId en el where', async () => {
      prisma.client.findFirst.mockResolvedValue(null as never);

      await expect(service.listCycles(ORG, 'other-client')).rejects.toMatchObject({
        code: 'CLIENT_NOT_FOUND',
        statusCode: 404,
      });
      expect(prisma.client.findFirst.mock.calls[0][0]!.where).toMatchObject({
        id: 'other-client',
        organizationId: ORG,
      });
    });
  });
});
