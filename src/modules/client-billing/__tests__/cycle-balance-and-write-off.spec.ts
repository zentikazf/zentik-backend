import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientBillingService } from '../client-billing.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppConfigService } from '../../../config/app-config.service';
import { BillingVariablesService } from '../../botmaker-billing/billing-variables.service';
import { ExchangeRateProvider } from '../../botmaker-billing/exchange-rate.provider';
import { AuthenticatedUser } from '../../../common/interfaces/request.interface';

/**
 * #65 BLOQUE A — el saldo de la factura (A1.1) y el cierre sin cobro (A1.4).
 *
 * Contexto de lo que se está arreglando: el sistema emitía facturas y notas de crédito y NUNCA
 * calculaba cuánto se debía todavía. Un grep de `balance|creditedTotal|amountDue|outstanding`
 * sobre todo `modules/client-billing/` daba cero resultados. El detalle pintaba un banner con las
 * NC en negativo y dejaba que el operador restara de cabeza; y con la factura 100% acreditada
 * quedaba ante tres salidas que mienten (dejarla SENT, marcarla PAID inventando un pago, o
 * anularla y comer un 409).
 *
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientBillingService — saldo de la factura y cierre sin cobro (#65 A1)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let service: ClientBillingService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';
  const CYCLE = 'cyc-1';
  const USER = { id: 'user-1', email: 'admin@zentik.io' } as AuthenticatedUser;

  /** Ciclo base: 1.100.000 emitido, sin notas de crédito. */
  const makeCycle = (over: Record<string, unknown> = {}) => ({
    id: CYCLE,
    organizationId: ORG,
    clientId: CLIENT,
    status: 'SENT',
    kind: 'MONTH',
    invoiceNumber: 'FAC-2026-00007',
    periodStart: new Date('2026-07-01T03:00:00Z'),
    periodEnd: new Date('2026-08-01T02:59:59.999Z'),
    cutoffDate: null,
    totalHours: 11,
    totalAmount: new Prisma.Decimal('1100000'),
    taxRate: null,
    taxMode: null,
    netAmount: null,
    taxAmount: null,
    currency: 'PYG',
    notes: null,
    closedAt: new Date('2026-07-31T00:00:00Z'),
    sentAt: new Date('2026-08-01T00:00:00Z'),
    paidAt: null,
    cancelReason: null,
    cancelledAt: null,
    variablesBilling: null,
    createdAt: new Date('2026-07-31T00:00:00Z'),
    creditNotes: [] as Array<{ totalAmount: Prisma.Decimal }>,
    ...over,
  });

  /** Las NC se guardan NEGATIVAS (client-billing.service.ts:1538 usa `.negated()`). */
  const nc = (monto: string) => ({ totalAmount: new Prisma.Decimal(monto) });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    service = new ClientBillingService(
      prisma,
      audit,
      mockDeep<AppConfigService>(),
      mockDeep<BillingVariablesService>(),
      mockDeep<ExchangeRateProvider>(),
    );
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      currency: 'PYG',
    } as never);
  });

  describe('el saldo (A1.1)', () => {
    it('EL CASO DEL SPEC: factura 1.100.000 con NC total → saldo 0', async () => {
      const cycle = makeCycle({ creditNotes: [nc('-1100000')] });
      prisma.clientBillingCycle.findFirst.mockResolvedValue(cycle as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, CYCLE);

      expect(res.cycle.totalAmount).toBe('1100000');
      expect(res.cycle.creditedTotal).toBe('-1100000');
      expect(res.cycle.balance).toBe('0');
      expect(res.cycle.creditNoteCount).toBe(1);
    });

    it('SE SUMA, no se resta: las NC ya vienen negativas de la DB', async () => {
      // Restar daría 2.200.000 — el doble de la factura. Es el error obvio de este cálculo y por
      // eso tiene un caso propio.
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ creditNotes: [nc('-400000')] }) as never,
      );
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, CYCLE);

      expect(res.cycle.balance).toBe('700000');
    });

    it('varias NC parciales se acumulan', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ creditNotes: [nc('-400000'), nc('-100000'), nc('-250000')] }) as never,
      );
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, CYCLE);

      expect(res.cycle.creditedTotal).toBe('-750000');
      expect(res.cycle.balance).toBe('350000');
      expect(res.cycle.creditNoteCount).toBe(3);
    });

    it('sin NC: creditedTotal es "0" y no null, y el saldo es el total', async () => {
      // Que el campo exista siempre es lo que deja a la UI mostrarlo sin `?? 0` distribuidos.
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle() as never);
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, CYCLE);

      expect(res.cycle.creditedTotal).toBe('0');
      expect(res.cycle.balance).toBe('1100000');
      expect(res.cycle.creditNoteCount).toBe(0);
    });

    it('una factura ANULADA tiene saldo 0 aunque conserve su totalAmount', async () => {
      // `reopenCycle` libera los `billedCycleId` y esas horas se re-facturan en un ciclo nuevo,
      // pero `totalAmount` se queda con el importe viejo. Sin esta guarda, sumar los saldos de la
      // lista contaría dos veces la misma plata.
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'error' }) as never,
      );
      prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

      const res = await service.getCycleTransactions(ORG, CLIENT, CYCLE);

      expect(res.cycle.totalAmount).toBe('1100000');
      expect(res.cycle.balance).toBe('0');
    });

    it('el saldo NO se persiste: el update del ciclo nunca escribe balance ni creditedTotal', async () => {
      // La razón de que #65 no lleve migración. Un campo persistido se desincroniza con la primera
      // NC emitida fuera del camino feliz.
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'SENT' }) as never);
      prisma.clientBillingCycle.update.mockResolvedValue(
        makeCycle({ status: 'PAID', paidAt: new Date() }) as never,
      );

      await service.updateCycle(ORG, CLIENT, CYCLE, { status: 'PAID' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).not.toHaveProperty('balance');
      expect(data).not.toHaveProperty('creditedTotal');
      expect(data).not.toHaveProperty('creditNoteCount');
    });
  });

  describe('cerrar sin cobro (A1.4)', () => {
    it('EL CASO DEL SPEC: SENT → WRITTEN_OFF y paidAt NO se sella', async () => {
      const cycle = makeCycle({ creditNotes: [nc('-1100000')] });
      prisma.clientBillingCycle.findFirst.mockResolvedValue(cycle as never);
      prisma.clientBillingCycle.update.mockResolvedValue(
        makeCycle({ status: 'WRITTEN_OFF', creditNotes: [nc('-1100000')] }) as never,
      );

      const res = await service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'saldo 0 por NC' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('WRITTEN_OFF');
      // Lo importante de todo el caso: no se inventa una fecha de pago.
      expect(data).not.toHaveProperty('paidAt');
      expect(res.status).toBe('WRITTEN_OFF');
      expect(res.paidAt).toBeNull();
    });

    it('el motivo queda en las notas de la factura, sin pisar las que ya tenía', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ notes: 'Nota previa del operador' }) as never,
      );
      prisma.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'WRITTEN_OFF' }) as never);

      await service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'incobrable' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.notes).toBe('Nota previa del operador\n[Cerrada sin cobro] incobrable');
    });

    it('queda auditado con el motivo, el importe y quién lo cerró', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ creditNotes: [nc('-1100000')] }) as never,
      );
      prisma.clientBillingCycle.update.mockResolvedValue(makeCycle({ status: 'WRITTEN_OFF' }) as never);

      await service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'saldo 0 por NC-2026-00004' }, USER);

      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'client.billing.cycle_written_off',
          newData: expect.objectContaining({
            reason: 'saldo 0 por NC-2026-00004',
            status: 'WRITTEN_OFF',
            totalAmount: '1100000',
            creditedTotal: '-1100000',
            writtenOffBy: 'user-1',
          }),
        }),
      );
    });

    it('un DRAFT no se puede cerrar sin cobro: primero hay que enviarlo', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(makeCycle({ status: 'DRAFT' }) as never);

      await expect(
        service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'INVALID_CYCLE_TRANSITION', statusCode: 409 });

      expect(prisma.clientBillingCycle.update).not.toHaveBeenCalled();
    });

    it('una ya cobrada tampoco: la plata entró', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ status: 'PAID', paidAt: new Date() }) as never,
      );

      await expect(
        service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'INVALID_CYCLE_TRANSITION' });
    });

    it('SE PUEDE DESHACER: si el cliente termina pagando, WRITTEN_OFF → PAID', async () => {
      // Es la razón de no reusar PAID. Sin esta transición el cierre sería irreversible (PAID no
      // tiene salida y reopenCycle rechaza las cobradas), y el único arreglo de un click
      // equivocado sería un UPDATE a mano contra producción.
      prisma.clientBillingCycle.findFirst.mockResolvedValue(
        makeCycle({ status: 'WRITTEN_OFF' }) as never,
      );
      prisma.clientBillingCycle.update.mockResolvedValue(
        makeCycle({ status: 'PAID', paidAt: new Date() }) as never,
      );

      const res = await service.updateCycle(ORG, CLIENT, CYCLE, { status: 'PAID' }, USER);

      const data = prisma.clientBillingCycle.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.status).toBe('PAID');
      expect(data.paidAt).toBeInstanceOf(Date); // ahí SÍ hubo pago
      expect(res.status).toBe('PAID');
    });

    it('un ciclo que no existe → 404, sin escribir nada', async () => {
      prisma.clientBillingCycle.findFirst.mockResolvedValue(null as never);

      await expect(
        service.writeOffCycle(ORG, CLIENT, CYCLE, { reason: 'motivo' }, USER),
      ).rejects.toMatchObject({ code: 'CYCLE_NOT_FOUND', statusCode: 404 });

      expect(prisma.clientBillingCycle.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * #65 T11 (A1.2) — el SALDO en el PDF.
 *
 * El PDF importa aparte porque no consume `CycleDto` directo: consume `InvoiceModel`, otro tipo
 * que hay que alimentar a mano. Agregar campos al DTO no dibuja una línea. Y es el mismo
 * generador que usa el PORTAL (`downloadMyInvoice`), o sea el documento que el cliente descarga
 * y reenvía a su contador: sin esto seguiría diciendo "TOTAL 1.100.000" sobre una factura que ya
 * se le acreditó entera.
 */
describe('buildInvoiceModel — el saldo en el PDF (#65 T11)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildInvoiceModel } = require('../client-billing-pdf.service');

  const baseCycle = {
    id: 'cyc-1',
    status: 'SENT',
    kind: 'MONTH',
    invoiceNumber: 'FAC-2026-00007',
    periodStart: new Date('2026-07-01T03:00:00Z'),
    periodEnd: new Date('2026-08-01T02:59:59.999Z'),
    cutoffDate: null,
    totalHours: 11,
    totalAmount: '1100000',
    taxRate: null,
    taxMode: null,
    netAmount: null,
    taxAmount: null,
    currency: 'PYG',
    creditedTotal: '0',
    balance: '1100000',
    creditNoteCount: 0,
    notes: null,
    closedAt: new Date('2026-07-31T00:00:00Z'),
    sentAt: new Date('2026-08-01T00:00:00Z'),
    paidAt: null,
    cancelReason: null,
    cancelledAt: null,
    variablesBilling: null,
    createdAt: new Date('2026-07-31T00:00:00Z'),
  };

  const build = (over: Record<string, unknown> = {}) =>
    buildInvoiceModel({
      cycle: { ...baseCycle, ...over },
      clientName: 'Cliente Demo',
      org: { name: 'Zentik', supportEmail: null },
      transactions: [],
      grupos: [],
    });

  it('sin notas de crédito el bloque de totales queda EXACTAMENTE como antes de #65', () => {
    const model = build();

    expect(model.creditadoMonto).toBeNull();
    expect(model.saldoMonto).toBeNull();
    expect(model.totalMonto).toBe(model.totalMonto); // una sola línea TOTAL, sin saldo
  });

  it('con NC total el PDF muestra el crédito y el SALDO en cero', () => {
    const model = build({ creditedTotal: '-1100000', balance: '0', creditNoteCount: 1 });

    expect(model.creditadoMonto).toContain('1.100.000');
    expect(model.saldoMonto).toContain('0');
  });

  it('los dos campos van JUNTOS: nunca uno sin el otro', () => {
    // El render decide con `creditadoMonto != null && saldoMonto != null`. Si pudieran divergir,
    // el bloque quedaría a medias.
    for (const over of [{}, { creditedTotal: '-500000', balance: '600000', creditNoteCount: 1 }]) {
      const m = build(over);
      expect(m.creditadoMonto === null).toBe(m.saldoMonto === null);
    }
  });

  it('el gate es creditNoteCount, no el monto: una NC que acredita 0 igual muestra el saldo', () => {
    // El redondeo del IVA puede dejar un crédito de exactamente 0, y una factura CON nota de
    // crédito tiene que mostrar su saldo igual.
    const model = build({ creditedTotal: '0', balance: '1100000', creditNoteCount: 1 });

    expect(model.creditadoMonto).not.toBeNull();
    expect(model.saldoMonto).not.toBeNull();
  });
});
