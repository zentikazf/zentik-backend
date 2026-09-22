import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientBillingService } from '../client-billing.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AppConfigService } from '../../../config/app.config';
import { BillingVariablesService } from '../../botmaker-billing/billing-variables.service';
import { ExchangeRateProvider } from '../../botmaker-billing/exchange-rate/exchange-rate.provider';
import { PreviewCycleDto } from '../dto/preview-cycle.dto';

/**
 * #72 A — Rollup de las tres cards de facturación de la pantalla de tiempos del STAFF.
 *
 * Prisma MOCKEADO con jest-mock-extended — NUNCA toca DATABASE_URL (prod).
 *
 * Lo que esta suite protege:
 *  - A1: el "Pendiente" del staff ES el conjunto facturable, no un número parecido. El test que
 *    justifica el bloque entero compara contra `previewCycle` con el mismo cliente y la misma
 *    fecha, y además exige que el predicado sea el MISMO objeto — no uno equivalente escrito a
 *    mano, que es como las dos definiciones se separarían con el tiempo sin que nadie lo note.
 *  - A2.1: los CINCO estados de ciclo caen en el bucket que les toca, incluidos `CANCELLED` y
 *    `WRITTEN_OFF`.
 *  - A1.5: un BORRADOR sale de "Pendiente" (ya está estampado) y va a "Facturado".
 *  - A3.2: y aun así su `billingState` de fila sigue siendo `'PENDING'` — el front tipa ese campo
 *    como una unión CERRADA de tres valores, así que un cuarto no rompería el build: rompería el
 *    badge en producción, con Vercel y Railway desplegando por separado.
 */
describe('ClientBillingService.getHoursBillingRollup — las tres cards del staff (#72 A)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let config: DeepMockProxy<AppConfigService>;
  let variables: DeepMockProxy<BillingVariablesService>;
  let exchangeRate: DeepMockProxy<ExchangeRateProvider>;
  let service: ClientBillingService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** El mes corriente en Asunción, con la misma cuenta que hace el service. */
  const periodoCorriente = (() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Asuncion',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')!.value;
    const m = parts.find((p) => p.type === 'month')!.value;
    return `${y}-${m}`;
  })();

  /** Un día de trabajo dentro del mes corriente (UTC-midnight = día calendario Asunción). */
  const diaDelMes = (() => {
    const [y, m] = periodoCorriente.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 5));
  })();

  /** Fila del agregado por ciclo (`groupBy`), de donde salen los buckets. */
  const grupo = (billedCycleId: string | null, priceAmount: string, hours = 1) => ({
    billedCycleId,
    _sum: { priceAmount: new Prisma.Decimal(priceAmount), hours },
  });

  /** Ciclo con el `select` mínimo que pide el rollup. */
  const ciclo = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    invoiceNumber: `FAC-2026-${id}`,
    kind: 'MONTH',
    status,
    periodStart: new Date('2026-07-01T03:00:00Z'),
    periodEnd: new Date('2026-08-01T02:59:59.999Z'),
    cutoffDate: null,
    currency: 'PYG',
    sentAt: status === 'DRAFT' ? null : new Date('2026-08-02T12:00:00Z'),
    paidAt: status === 'PAID' ? new Date('2026-08-20T12:00:00Z') : null,
    createdAt: new Date('2026-08-01T12:00:00Z'),
    taxMode: null,
    creditNotes: [] as Array<{ totalAmount: Prisma.Decimal }>,
    ...over,
  });

  /**
   * Stub de las 4 consultas del rollup, EN EL ORDEN en que las lanza el `Promise.all`:
   * aggregate(pendiente) → groupBy(sumas) → groupBy(acreditado) → cycle.findMany.
   */
  function stubRollup(opts: {
    pendiente?: string | null;
    sumas?: ReturnType<typeof grupo>[];
    acreditado?: ReturnType<typeof grupo>[];
    ciclos?: ReturnType<typeof ciclo>[];
  }) {
    prisma.hoursTransaction.aggregate.mockResolvedValue({
      _sum: { priceAmount: opts.pendiente == null ? null : new Prisma.Decimal(opts.pendiente) },
    } as never);
    prisma.hoursTransaction.groupBy
      .mockResolvedValueOnce((opts.sumas ?? []) as never)
      .mockResolvedValueOnce((opts.acreditado ?? []) as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue((opts.ciclos ?? []) as never);
  }

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    config = mockDeep<AppConfigService>();
    variables = mockDeep<BillingVariablesService>();
    exchangeRate = mockDeep<ExchangeRateProvider>();
    service = new ClientBillingService(prisma, audit, config, variables, exchangeRate);

    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      currency: 'PYG',
      taxRate: null,
      taxMode: 'INCLUDED',
    } as never);

    variables.collectCommercial.mockResolvedValue({
      lines: [],
      subtotalUsd: 0,
      contributingPeriods: [],
    } as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);
  });

  // ── EL test del bloque ────────────────────────────────────────────────────
  describe('A1 — "Pendiente" es lo que el botón de facturar puede facturar', () => {
    it('da el MISMO número que previewCycle, con el mismo cliente y la misma fecha', async () => {
      const filas = [
        {
          id: 'h1',
          type: 'USAGE',
          hours: 2,
          note: null,
          createdAt: new Date(),
          workedOn: diaDelMes,
          priceAmount: new Prisma.Decimal('100000'),
          priceRate: new Prisma.Decimal('50000'),
          priceCurrency: 'PYG',
          task: { id: 't1', title: 'Soporte', type: 'SUPPORT' },
        },
        {
          id: 'h2',
          type: 'USAGE',
          hours: 5,
          note: null,
          createdAt: new Date(),
          workedOn: diaDelMes,
          priceAmount: new Prisma.Decimal('250000'),
          priceRate: new Prisma.Decimal('50000'),
          priceCurrency: 'PYG',
          task: { id: 't2', title: 'Soporte 2', type: 'SUPPORT' },
        },
      ];
      const totalFacturable = '350000';

      // El rollup: el aggregate devuelve la suma de ESAS filas.
      stubRollup({ pendiente: totalFacturable });
      const rollup = await service.getHoursBillingRollup(ORG, CLIENT);

      // previewCycle sobre el MISMO mes: guard R11 → guard workedOn-null → candidatos → revertidas.
      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never); // closedMonthKeys
      prisma.hoursTransaction.findMany
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce(filas as never)
        .mockResolvedValueOnce([] as never);
      const preview = await service.previewCycle(ORG, CLIENT, {
        mode: 'MES',
        period: periodoCorriente,
      } as PreviewCycleDto);

      expect(rollup.billing.pending.amount).toBe(totalFacturable);
      expect(preview.total).toBe(totalFacturable);
      expect(rollup.billing.pending.amount).toBe(preview.total);
    });

    it('usa EL MISMO predicado que previewCycle, no uno equivalente escrito a mano', async () => {
      stubRollup({ pendiente: '0' });
      await service.getHoursBillingRollup(ORG, CLIENT);

      prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
      await service.previewCycle(ORG, CLIENT, {
        mode: 'MES',
        period: periodoCorriente,
      } as PreviewCycleDto);

      const wherePendiente = prisma.hoursTransaction.aggregate.mock.calls[0][0].where;
      // 3ra llamada de previewCycle: guard R11, guard workedOn-null, CANDIDATOS.
      const whereCandidatos = prisma.hoursTransaction.findMany.mock.calls[2][0]?.where;

      // Mismo mes ⇒ mismo borde superior ⇒ los dos `where` son idénticos, campo por campo. Si
      // alguien reescribe uno de los dos a mano, este test se cae antes de que las dos pantallas
      // se separen en silencio.
      expect(wherePendiente).toEqual(whereCandidatos);
    });

    it('el predicado excluye las tareas PROJECT y las filas sin workedOn (A1.1)', async () => {
      stubRollup({ pendiente: '0' });
      await service.getHoursBillingRollup(ORG, CLIENT);

      const where = prisma.hoursTransaction.aggregate.mock.calls[0][0].where as Record<string, unknown>;

      // Sólo SUPPORT: lo que no es soporte no lo factura este flujo.
      expect(where.task).toEqual({ type: 'SUPPORT' });
      // `workedOn: { lte: … }` deja fuera los NULL por construcción: un null nunca satisface `lte`.
      expect(where.workedOn).toHaveProperty('lte');
      // Y lo ya estampado tampoco entra: está adentro de otra factura.
      expect(where.billedCycleId).toBeNull();
      expect(where.priceAmount).toEqual({ not: null });
    });

    it('el modo de IVA de "Pendiente" sale del CLIENTE (todavía no hay documento emitido)', async () => {
      stubRollup({ pendiente: '350000' });
      const rollup = await service.getHoursBillingRollup(ORG, CLIENT);
      expect(rollup.billing.pending.taxMode).toBe('INCLUDED');
    });
  });

  // ── A2.1 — los cinco estados ──────────────────────────────────────────────
  describe('A2.1 — los cinco estados de ciclo caen en el bucket que les toca', () => {
    it('DRAFT, SENT, WRITTEN_OFF y CANCELLED → Facturado; PAID → Cobrado', async () => {
      stubRollup({
        pendiente: '0',
        sumas: [
          grupo('c-draft', '100'),
          grupo('c-sent', '200'),
          grupo('c-paid', '400'),
          grupo('c-wo', '800'),
          grupo('c-cancel', '1600'),
        ],
        ciclos: [
          ciclo('c-draft', 'DRAFT'),
          ciclo('c-sent', 'SENT'),
          ciclo('c-paid', 'PAID'),
          ciclo('c-wo', 'WRITTEN_OFF'),
          ciclo('c-cancel', 'CANCELLED'),
        ],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);

      // 100 + 200 + 800 + 1600: todo lo estampado que no se cobró.
      expect(billing.invoiced.amount).toBe('2700');
      expect(billing.paid.amount).toBe('400');
      expect(billing.invoiced.invoices.map((i) => i.id).sort()).toEqual([
        'c-cancel',
        'c-draft',
        'c-sent',
        'c-wo',
      ]);
      expect(billing.paid.invoices.map((i) => i.id)).toEqual(['c-paid']);
    });

    it('el estado viaja crudo para que el front etiquete Borrador / Anulada / Incobrable', async () => {
      stubRollup({
        pendiente: '0',
        sumas: [grupo('c-draft', '100')],
        ciclos: [ciclo('c-draft', 'DRAFT')],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);
      expect(billing.invoiced.invoices[0].status).toBe('DRAFT');
      // Un borrador no tiene envío ni pago: cae a su fecha de creación en vez de pintar un hueco.
      expect(billing.invoiced.invoices[0].date).toEqual(new Date('2026-08-01T12:00:00Z'));
    });

    it('un estado futuro que nadie enseñó a clasificar NO cae en Cobrado', async () => {
      stubRollup({
        pendiente: '0',
        sumas: [grupo('c-x', '999')],
        ciclos: [ciclo('c-x', 'UN_ESTADO_NUEVO')],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);
      // Está estampado, luego no es facturable; y no hay ninguna prueba de que haya entrado plata.
      expect(billing.paid.amount).toBe('0');
      expect(billing.invoiced.amount).toBe('999');
    });
  });

  // ── A1.5 / A3.2 — el borrador ─────────────────────────────────────────────
  describe('A1.5 / A3.2 — dónde cae un BORRADOR', () => {
    it('sale de Pendiente y va a Facturado: ya está estampado, el botón de facturar no lo toma', async () => {
      stubRollup({
        pendiente: '400000',
        sumas: [grupo('c-draft', '1000000')],
        ciclos: [ciclo('c-draft', 'DRAFT')],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);

      expect(billing.pending.amount).toBe('400000'); // el borrador NO suma acá
      expect(billing.invoiced.amount).toBe('1000000'); // …suma acá
      // Ninguna plata desaparece de la pantalla: o está en pendiente, o está en una factura.
      expect(billing.invoiced.invoices[0].invoiceNumber).toBe('FAC-2026-c-draft');
    });

    it('🔴 el `billingState` de una fila de un ciclo DRAFT sigue siendo "PENDING" (A3.2)', async () => {
      stubRollup({
        pendiente: '0',
        sumas: [grupo('c-draft', '1000000')],
        ciclos: [ciclo('c-draft', 'DRAFT')],
      });

      const { stateByCycleId } = await service.getHoursBillingRollup(ORG, CLIENT);

      // El front tipa `BillingState` como unión CERRADA de tres. Un cuarto valor NO rompe el
      // build: rompe el badge en producción, y Vercel y Railway despliegan por separado.
      expect(stateByCycleId['c-draft']).toBe('PENDING');
    });

    it('los cinco estados producen SÓLO los tres valores de la unión del front', async () => {
      stubRollup({
        pendiente: '0',
        ciclos: [
          ciclo('c-draft', 'DRAFT'),
          ciclo('c-sent', 'SENT'),
          ciclo('c-paid', 'PAID'),
          ciclo('c-wo', 'WRITTEN_OFF'),
          ciclo('c-cancel', 'CANCELLED'),
        ],
      });

      const { stateByCycleId } = await service.getHoursBillingRollup(ORG, CLIENT);

      expect(stateByCycleId).toEqual({
        'c-draft': 'PENDING',
        'c-sent': 'INVOICED',
        'c-paid': 'PAID',
        'c-wo': 'INVOICED',
        'c-cancel': 'PENDING',
      });
      const valores = new Set(Object.values(stateByCycleId));
      expect([...valores].every((v) => ['PENDING', 'INVOICED', 'PAID'].includes(v))).toBe(true);
    });
  });

  // ── Notas de crédito ──────────────────────────────────────────────────────
  describe('Notas de crédito, con y sin devolución de horas al pool', () => {
    it('SIN devolución: la card queda neta y el descuento se expone aparte', async () => {
      stubRollup({
        pendiente: '0',
        sumas: [grupo('c-sent', '1000000', 10)],
        acreditado: [grupo('c-sent', '300000', 3)],
        ciclos: [
          ciclo('c-sent', 'SENT', {
            creditNotes: [{ totalAmount: new Prisma.Decimal('-330000') }],
          }),
        ],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);

      expect(billing.invoiced.amount).toBe('700000'); // 1.000.000 − 300.000
      expect(billing.pending.amount).toBe('0'); // sin devolución, nada vuelve a facturable
      const factura = billing.invoiced.invoices[0];
      expect(factura.amount).toBe('700000'); // la fila SUMA la card que la contiene
      expect(factura.hours).toBe(7);
      // Lo acreditado DE ESTAS HORAS (sin IVA)…
      expect(factura.creditedAmount).toBe('300000');
      // …y lo acreditado del DOCUMENTO (con IVA), que es lo que cuadra contra el PDF.
      expect(factura.creditedTotal).toBe('-330000');
    });

    it('CON devolución: la fila espejo nace sin ciclo y vuelve a "Pendiente"', async () => {
      // La ORIGINAL conserva su `billedCycleId` (la factura es un snapshot inmutable) y queda
      // acreditada; la ESPEJO nace con `billedCycleId` null, así que entra al conjunto facturable.
      stubRollup({
        pendiente: '300000', // la espejo
        sumas: [grupo('c-sent', '1000000', 10)],
        acreditado: [grupo('c-sent', '300000', 3)],
        ciclos: [ciclo('c-sent', 'SENT')],
      });

      const { billing } = await service.getHoursBillingRollup(ORG, CLIENT);

      expect(billing.pending.amount).toBe('300000');
      expect(billing.invoiced.amount).toBe('700000');
      // Un solo trabajo, una sola vez: la espejo está en pendiente y la original ya neteada.
    });
  });

  // ── Tenencia ──────────────────────────────────────────────────────────────
  it('A2.3 — un cliente de otra organización es 404, sin sumar un solo peso', async () => {
    prisma.client.findFirst.mockResolvedValue(null as never);

    await expect(service.getHoursBillingRollup(ORG, CLIENT)).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
    // `PermissionsGuard` nunca mira el `:orgId` de la URL: si el service no corta, no corta nadie.
    expect(prisma.hoursTransaction.aggregate).not.toHaveBeenCalled();
    expect(prisma.hoursTransaction.groupBy).not.toHaveBeenCalled();
  });
});
