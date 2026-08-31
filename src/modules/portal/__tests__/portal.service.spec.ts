import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PortalService } from '../portal.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { FileService } from '../../file/file.service';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { OutboxService } from '../../sync/outbox.service';
import { ClientBillingPdfService } from '../../client-billing/client-billing-pdf.service';
import { PORTAL_VISIBLE_INVOICE_WHERE } from '../invoice-visibility.util';

/**
 * H8f — getMyInvoices: scoping del portal. Prisma MOCKEADO (jest-mock-extended), NUNCA toca
 * DATABASE_URL (prod). GATE-1: el cliente ve SENT/PAID/CANCELLED de SU cliente; nunca DRAFT.
 */
describe('PortalService.getMyInvoices (H8f)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PortalService;

  const CLIENT = 'client-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
    );
    // getClientByUserId → owner path
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, organizationId: 'org-1' } as never);
    // H9b: getMyInvoices ahora hace Promise.all([cycles, creditNotes]); default vacío para las NC.
    prisma.creditNote.findMany.mockResolvedValue([] as never);
  });

  it('scopea por el cliente del usuario y usa la regla de visibilidad compartida (#61)', async () => {
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);

    await service.getMyInvoices('user-1');

    expect(prisma.clientBillingCycle.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.clientBillingCycle.findMany.mock.calls[0][0] as any;
    expect(arg.where.clientId).toBe(CLIENT);
    // ⚠️ El where sale del helper, NO se escribe inline. Se compara contra la constante misma: si
    // alguien la cambia, este test acompaña; si alguien vuelve a escribir el filtro a mano en el
    // call site, este test lo caza.
    expect(arg.where.OR).toEqual(PORTAL_VISIBLE_INVOICE_WHERE.OR);
    // y las dos garantías que importan, explícitas para que se lean acá:
    expect(JSON.stringify(arg.where)).not.toContain('DRAFT'); // nunca un borrador
    const cancelled = arg.where.OR.find((c: any) => c.status === 'CANCELLED');
    expect(cancelled.sentAt).toEqual({ not: null }); // un anulado SOLO si se envió
    expect(arg.orderBy).toEqual({ periodStart: 'desc' });
    // el select no expone notas internas del staff
    expect(arg.select.notes).toBeUndefined();
  });

  it('#61 — el CANCELLED del where nunca es incondicional (era el bug)', async () => {
    // El filtro viejo era status: { in: [SENT, PAID, CANCELLED] }. Con ese CANCELLED suelto,
    // descartar un BORRADOR le mostraba al cliente una factura "Anulada" que nunca existió para
    // él: no la recibió, no la vio, y ni siquiera le movió un número del portal.
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);

    await service.getMyInvoices('user-1');

    const arg = prisma.clientBillingCycle.findMany.mock.calls[0][0] as any;
    expect(arg.where.status).toBeUndefined(); // ya no hay un status suelto de nivel superior
    const incondicional = arg.where.OR.find(
      (c: any) => c.status?.in?.includes('CANCELLED') || (c.status === 'CANCELLED' && !c.sentAt),
    );
    expect(incondicional).toBeUndefined();
  });

  it('H9b — devuelve { invoices, creditNotes }: FAC con docType INVOICE y NC con docType CREDIT_NOTE (monto negativo)', async () => {
    const rows = [{ id: 'cyc1', invoiceNumber: 'FAC-2026-00001', status: 'SENT' }];
    prisma.clientBillingCycle.findMany.mockResolvedValue(rows as never);
    prisma.creditNote.findMany.mockResolvedValue([
      {
        id: 'nc1',
        number: 'NC-2026-00001',
        totalAmount: '-150000',
        totalHours: -3,
        currency: 'PYG',
        issuedAt: new Date('2026-07-28T12:00:00Z'),
        appliesTo: { invoiceNumber: 'FAC-2026-00001' },
      },
    ] as never);

    const res = await service.getMyInvoices('user-1');

    expect(res.invoices).toEqual([{ docType: 'INVOICE', id: 'cyc1', invoiceNumber: 'FAC-2026-00001', status: 'SENT' }]);
    expect(res.creditNotes).toHaveLength(1);
    expect(res.creditNotes[0]).toMatchObject({
      docType: 'CREDIT_NOTE',
      id: 'nc1',
      number: 'NC-2026-00001',
      appliesToInvoiceNumber: 'FAC-2026-00001',
      totalAmount: '-150000',
      totalHours: -3,
    });
    // solo las NC de facturas SENT/PAID (nunca DRAFT/CANCELLED).
    const ncArg = prisma.creditNote.findMany.mock.calls[0][0] as any;
    expect(ncArg.where.clientId).toBe(CLIENT);
    expect(ncArg.where.appliesTo.status.in).toEqual(['SENT', 'PAID']);
  });

  it('sin NC devuelve creditNotes vacío y las FAC en invoices', async () => {
    prisma.clientBillingCycle.findMany.mockResolvedValue([{ id: 'cyc1', status: 'PAID' }] as never);

    const res = await service.getMyInvoices('user-1');

    expect(res.creditNotes).toEqual([]);
    expect(res.invoices).toEqual([{ docType: 'INVOICE', id: 'cyc1', status: 'PAID' }]);
  });
});

/**
 * #23 — getMyVariables: scoping por cliente + DTO allowlist (solo label + commercialValue; nunca rawValue,
 * source ni datos de Botmaker) + gate portalBillingEnabled. Prisma MOCKEADO.
 */
describe('PortalService.getMyVariables (#23)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PortalService;
  const CLIENT = 'client-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
    );
  });

  it('flag off: NO consulta statements y devuelve vacío', async () => {
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, portalBillingEnabled: false } as never);
    const res = await service.getMyVariables('user-1');
    expect(res).toEqual({ statements: [] });
    expect(prisma.clientBillingStatement.findMany).not.toHaveBeenCalled();
  });

  it('flag on: allowlist (solo label + commercialValue), total server-side, scopeado por cliente', async () => {
    prisma.client.findFirst.mockResolvedValue({ id: CLIENT, portalBillingEnabled: true } as never);
    prisma.clientBillingStatement.findMany.mockResolvedValue([
      {
        period: '2026-04',
        note: 'abril',
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        items: [
          { label: 'SESSIONS', rawValue: 415.81, commercialValue: 500, source: 'BOTMAKER' },
          { label: 'FEE', rawValue: null, commercialValue: 299, source: 'MANUAL' },
          { label: 'ZERO', rawValue: 1, commercialValue: 0, source: 'BOTMAKER' }, // excluido (0)
          { label: 'OFF', rawValue: 9, commercialValue: 777, source: 'BOTMAKER', enabled: false }, // #23 ojito: oculta al cliente
        ],
      },
    ] as never);

    const res = await service.getMyVariables('user-1');

    // scopeado por el cliente del user
    const arg = prisma.clientBillingStatement.findMany.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ clientId: CLIENT });

    expect(res.statements).toHaveLength(1);
    const s = res.statements[0];
    expect(s.total).toBe(799); // 500 + 299 — la deshabilitada (777) NO aparece ni suma
    expect(s.items).toEqual([
      { label: 'SESSIONS', commercialValue: 500 },
      { label: 'FEE', commercialValue: 299 },
    ]);
    // NUNCA expone rawValue ni source
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('rawValue');
    expect(serialized).not.toContain('BOTMAKER');
    expect(serialized).not.toContain('415.81');
  });
});

/**
 * #55 — getMyHours: el portal NO deduce el acreditado desde la fila espejo. El backend lo resuelve
 * con la línea de la nota de crédito (CreditNoteLine, @unique por transacción) y lo aplana a
 * `creditNoteNumber` + `creditedDescription`. Prisma MOCKEADO.
 */
describe('PortalService.getMyHours — acreditado por nota de crédito (#55)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PortalService;
  const CLIENT = 'client-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
    );
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      contractedHours: 10,
      usedHours: 5,
      loanedHours: 0,
      currency: 'PYG',
      developmentHourlyRate: null,
      supportHourlyRate: null,
    } as never);
    // #62 — getMyHours resuelve los tres buckets con dos consultas mas (agregado por ciclo +
    // estado de los ciclos del cliente). Default vacio: sin ciclos, todo cae en PENDIENTE.
    prisma.hoursTransaction.groupBy.mockResolvedValue([] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
  });

  it('incluye la línea de la nota de crédito (no infiere desde la fila espejo)', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

    await service.getMyHours('user-1');

    const arg = prisma.hoursTransaction.findMany.mock.calls[0][0] as any;
    // el número de la NC sale de la relación, no de parsear el `note` de ninguna fila.
    // (Va bajo `select` y no bajo `include`: ver el bloque de tests del payload más abajo.)
    expect(arg.select.creditedByLine.select).toEqual({
      description: true,
      creditNote: { select: { number: true } },
    });
  });

  it('expone creditNoteNumber + creditedDescription y descarta el objeto crudo de la relación', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-original',
        hours: 5,
        note: null,
        priceAmount: '500000',
        billedCycleId: 'cyc-1',
        creditedByLine: {
          description: 'Migración de datos',
          creditNote: { number: 'NC-2026-00001' },
        },
      },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions[0]).toMatchObject({
      id: 'tx-original',
      creditNoteNumber: 'NC-2026-00001',
      creditedDescription: 'Migración de datos',
    });
    expect((res.transactions[0] as any).creditedByLine).toBeUndefined();
  });

  it('sin devolución de horas (no hay fila espejo) el movimiento igual sale acreditado', async () => {
    // El staff apagó "devolver horas al pool": NO existe la copia re-facturable, sólo la línea de la NC.
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-original',
        hours: 5,
        priceAmount: '500000',
        billedCycleId: 'cyc-1',
        rebilledFromTransactionId: null,
        creditedByLine: { description: 'Soporte', creditNote: { number: 'NC-2026-00002' } },
      },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0].creditNoteNumber).toBe('NC-2026-00002');
  });

  it('cliente SIN notas de crédito: ambos campos en null y el resto del payload intacto', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-1',
        hours: 3,
        note: 'Carga manual',
        priceAmount: '300000',
        billedCycleId: null,
        creditedByLine: null,
      },
    ] as never);
    // #62 — el KPI ya no se suma sobre la ventana de 100 filas: sale del agregado por ciclo.
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      { billedCycleId: null, _sum: { priceAmount: '300000', hours: 3 } },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions).toEqual([
      {
        id: 'tx-1',
        hours: 3,
        note: 'Carga manual',
        priceAmount: '300000',
        billedCycleId: null,
        creditNoteNumber: null,
        creditedDescription: null,
        // #62 — sin ciclo, el movimiento esta pendiente de facturar.
        billingState: 'PENDING',
      },
    ]);
    // el KPI "Pendiente de facturar" no cambia: sigue sumando lo que tiene precio y no fue facturado
    expect(res.totalAmount).toBe(300000);
  });
});

/**
 * #55 (cierre) — getMyHours: la jerga interna se escondió de la PANTALLA pero no del PAYLOAD.
 *
 * El findMany usaba `include` sin `select` de nivel superior, así que /portal/hours mandaba al
 * navegador del CLIENTE todos los escalares del ledger (`timeEntryId`, `entryVersion`,
 * `reversesTransactionId`, `deletedById`, `deleteReason`, `clientId`) y el `note` "Re-facturable
 * por NC-…" de la fila espejo — reproducible con DevTools > Network. Misma regla que ya seguía
 * `getTicketDetail`: select explícito, nunca include a secas.
 *
 * Estos tests miran las DOS mitades del agujero:
 *  - la FORMA de la query (qué campos se piden), que es lo que evita que un campo nuevo del
 *    schema empiece a viajar solo;
 *  - la FORMA de la respuesta (qué campos llegan), que es lo que el cliente ve de verdad.
 * Prisma MOCKEADO.
 */
describe('PortalService.getMyHours — el payload no filtra plomería interna (#55 cierre)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PortalService;
  const CLIENT = 'client-1';

  /** Campos que el portal del cliente SÍ consume (interface HoursTransaction + JSX). */
  const CAMPOS_DEL_PORTAL = [
    'id',
    'type',
    'hours',
    'note',
    'createdAt',
    'workedOn',
    'priceAmount',
    'priceRate',
    'priceCurrency',
    'billedCycleId',
    'rebilledFromTransactionId',
  ];
  // OJO: `billingState` (#62) NO va en esta lista — no es un campo del schema, es un DERIVADO
  // que el servicio calcula mirando el estado del ciclo. Se verifica en el bloque de #62.

  /** Plomería interna del ledger: ninguno lo usa el portal y ninguno es del cliente. */
  const CAMPOS_INTERNOS = [
    'timeEntryId',
    'entryVersion',
    'reversesTransactionId',
    'deletedById',
    'deleteReason',
    'deletedAt',
    'clientId',
  ];

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
    );
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      contractedHours: 10,
      usedHours: 5,
      loanedHours: 0,
      currency: 'PYG',
      developmentHourlyRate: null,
      supportHourlyRate: null,
    } as never);
    // #62 — getMyHours resuelve los tres buckets con dos consultas mas (agregado por ciclo +
    // estado de los ciclos del cliente). Default vacio: sin ciclos, todo cae en PENDIENTE.
    prisma.hoursTransaction.groupBy.mockResolvedValue([] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
  });

  const queryArg = (): any => prisma.hoursTransaction.findMany.mock.calls.at(-1)![0];

  it('la query usa `select` explícito, no `include` a secas (B1)', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

    await service.getMyHours('user-1');

    expect(queryArg().select).toBeDefined();
    expect(queryArg().include).toBeUndefined();
  });

  it('ningún campo interno del ledger se pide en la query (B2)', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

    await service.getMyHours('user-1');

    for (const campo of CAMPOS_INTERNOS) {
      expect(queryArg().select[campo]).toBeUndefined();
    }
  });

  it('TODOS los campos que consume la pantalla siguen pidiéndose (B3)', async () => {
    // El riesgo de enumerar es dropear un campo vivo: esta lista es el contrato con
    // app/(portal)/portal/hours/page.tsx. Si la pantalla necesita uno nuevo, se agrega en los dos.
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

    await service.getMyHours('user-1');

    for (const campo of CAMPOS_DEL_PORTAL) {
      expect(queryArg().select[campo]).toBe(true);
    }
    // la tarea alimenta el concepto y el badge de tipo (Soporte / Desarrollo)
    expect(queryArg().select.task.select).toMatchObject({
      id: true,
      title: true,
      type: true,
      project: { select: { id: true, name: true } },
    });
  });

  it('el `note` de una FILA ESPEJO no viaja: la jerga "Re-facturable por NC-…" queda en el backend (B4)', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-espejo',
        hours: 5,
        note: 'Re-facturable por NC-2026-00001',
        rebilledFromTransactionId: 'tx-original',
        priceAmount: '500000',
        billedCycleId: null,
        creditedByLine: null,
      },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions[0].note).toBeNull();
    expect(JSON.stringify(res)).not.toContain('Re-facturable');
    // el vínculo con el original SÍ se conserva: es lo que empareja las dos filas en la pantalla
    expect(res.transactions[0].rebilledFromTransactionId).toBe('tx-original');
  });

  it('el `note` de una fila NORMAL sigue llegando: es el concepto cuando no hay tarea (B5)', async () => {
    // El caso que hace peligroso el fix: si se dropea el `note` de todas las filas, la columna
    // "Tarea" del cliente se llena de '—' en toda carga manual sin tarea asociada.
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-manual',
        hours: 2,
        note: 'Ajuste de configuración solicitado por el cliente',
        rebilledFromTransactionId: null,
        task: null,
        priceAmount: '200000',
        billedCycleId: null,
        creditedByLine: null,
      },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions[0].note).toBe('Ajuste de configuración solicitado por el cliente');
  });

  it('el concepto congelado de la nota de crédito sigue llegando (B6)', async () => {
    // `creditedDescription` es el concepto que ve el cliente cuando la tarea se borró en duro.
    prisma.hoursTransaction.findMany.mockResolvedValue([
      {
        id: 'tx-original',
        hours: 5,
        note: null,
        rebilledFromTransactionId: null,
        priceAmount: '500000',
        billedCycleId: 'cyc-1',
        creditedByLine: {
          description: 'Migración de datos',
          creditNote: { number: 'NC-2026-00001' },
        },
      },
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions[0].creditedDescription).toBe('Migración de datos');
    expect(res.transactions[0].creditNoteNumber).toBe('NC-2026-00001');
  });
});

/**
 * #62 — Los tres estados de facturación del portal. Prisma MOCKEADO.
 *
 * El bug: el KPI único filtraba `billedCycleId === null` y el estampado ocurre al EMITIR, con el
 * ciclo naciendo en `DRAFT`. Generar un BORRADOR —que el cliente ni ve— le hacía desaparecer las
 * horas del pendiente.
 *
 * ⚠️ El arreglo NO mueve el estampado (eso congelaría mal el conjunto): es de LECTURA. Estos tests
 * miran las dos mitades:
 *  - la CLASIFICACIÓN (qué bucket se lleva cada peso, y qué badge lleva cada fila);
 *  - el DETALLE (qué facturas se listan y cuáles nunca).
 */
describe('PortalService.getMyHours — los tres estados de facturación (#62)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: PortalService;
  const CLIENT = 'client-1';

  /** Movimiento tal como lo devuelve el findMany de la ventana que se pinta. */
  const mov = (id: string, billedCycleId: string | null, priceAmount = '100000') => ({
    id,
    type: 'USAGE',
    hours: 1,
    note: null,
    priceAmount,
    billedCycleId,
    rebilledFromTransactionId: null,
    creditedByLine: null,
  });

  /** Fila del agregado por ciclo (`groupBy`). Es de donde salen los TRES buckets. */
  const grupo = (billedCycleId: string | null, priceAmount: string, hours = 1) => ({
    billedCycleId,
    _sum: { priceAmount, hours },
  });

  /** Ciclo del cliente con el `select` mínimo que pide el servicio. */
  const ciclo = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    status,
    invoiceNumber: `FAC-2026-${id}`,
    kind: 'MONTH',
    periodStart: new Date('2026-07-01T03:00:00Z'),
    periodEnd: new Date('2026-08-01T02:59:59Z'),
    cutoffDate: null,
    currency: 'PYG',
    sentAt: null,
    paidAt: null,
    ...extra,
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new PortalService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<AuditService>(),
      mockDeep<FileService>(),
      mockDeep<StorageService>(),
      mockDeep<OutboxService>(),
      mockDeep<ClientBillingPdfService>(),
    );
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      contractedHours: 10,
      usedHours: 5,
      loanedHours: 0,
      currency: 'PYG',
      developmentHourlyRate: null,
      supportHourlyRate: null,
      portalBillingEnabled: true, // el detalle de las cards se lista (ver el test del gate)
    } as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);
    prisma.hoursTransaction.groupBy.mockResolvedValue([] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);
  });

  // ── Clasificación ───────────────────────────────────────────────────────────

  it('R0 — horas estampadas en un BORRADOR cuentan como PENDIENTE (el bug que motivó #62)', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-draft', '4000000')] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([ciclo('cyc-draft', 'DRAFT')] as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([mov('tx-1', 'cyc-draft')] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.pending.amount).toBe('4000000');
    expect(res.billing.invoiced.amount).toBe('0');
    expect(res.billing.paid.amount).toBe('0');
    // La FILA también: tiene `billedCycleId` y NO está facturada. Es el badge de la tabla.
    expect(res.transactions[0].billedCycleId).toBe('cyc-draft');
    expect(res.transactions[0].billingState).toBe('PENDING');
    // Un borrador no le muestra ninguna factura al cliente.
    expect(res.billing.invoiced.invoices).toEqual([]);
    expect(res.billing.paid.invoices).toEqual([]);
  });

  it('R2 — SENT cae en FACTURADO y PAID en COBRADO', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo('cyc-sent', '3100000'),
      grupo('cyc-paid', '12000000'),
    ] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-sent', 'SENT', { sentAt: new Date('2026-08-01T12:00:00Z') }),
      ciclo('cyc-paid', 'PAID', {
        sentAt: new Date('2026-07-01T12:00:00Z'),
        paidAt: new Date('2026-07-10T12:00:00Z'),
      }),
    ] as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([
      mov('tx-sent', 'cyc-sent'),
      mov('tx-paid', 'cyc-paid'),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.invoiced.amount).toBe('3100000');
    expect(res.billing.paid.amount).toBe('12000000');
    expect(res.billing.pending.amount).toBe('0');
    expect(res.transactions[0].billingState).toBe('INVOICED');
    expect(res.transactions[1].billingState).toBe('PAID');
  });

  it('R2 — los tres buckets conviven y cada peso cae en exactamente uno', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo(null, '2400000'), // nunca facturado
      grupo('cyc-draft', '4000000'), // borrador → también pendiente
      grupo('cyc-sent', '3100000'),
      grupo('cyc-paid', '12000000'),
    ] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-draft', 'DRAFT'),
      ciclo('cyc-sent', 'SENT', { sentAt: new Date('2026-08-01T12:00:00Z') }),
      ciclo('cyc-paid', 'PAID', { sentAt: new Date('2026-07-01T12:00:00Z'), paidAt: new Date('2026-07-10T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.pending.amount).toBe('6400000'); // 2.400.000 + 4.000.000
    expect(res.billing.invoiced.amount).toBe('3100000');
    expect(res.billing.paid.amount).toBe('12000000');
  });

  it('R4.1 — `totalAmount` sobrevive con el mismo nombre y tipo, y vale exactamente el bucket PENDIENTE', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo(null, '2400000'),
      grupo('cyc-draft', '4000000'),
      grupo('cyc-paid', '12000000'),
    ] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-draft', 'DRAFT'),
      ciclo('cyc-paid', 'PAID', { sentAt: new Date('2026-07-01T12:00:00Z'), paidAt: new Date('2026-07-10T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    // number, no string: cualquier consumidor viejo lo sigue leyendo igual.
    expect(typeof res.totalAmount).toBe('number');
    expect(res.totalAmount).toBe(6400000);
    expect(String(res.totalAmount)).toBe(res.billing.pending.amount);
  });

  it('R2.1 — anular una factura devuelve las horas a PENDIENTE (por las dos vías)', async () => {
    // Vía real: `reopenCycle` libera el `billedCycleId` de todos los movimientos del ciclo
    // (probado en client-billing.service.spec: "reopenCycle"), así que vuelven sueltos.
    // Vía de respaldo: si por deriva de datos un movimiento quedara apuntando a un ciclo
    // CANCELLED, tampoco puede leerse como facturado.
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo(null, '3100000'), // liberado por la anulación
      grupo('cyc-cancel', '500000'), // huérfano apuntando a un ciclo anulado
    ] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-cancel', 'CANCELLED', { sentAt: new Date('2026-08-01T12:00:00Z') }),
    ] as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([mov('tx-1', 'cyc-cancel')] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.pending.amount).toBe('3600000');
    expect(res.billing.invoiced.amount).toBe('0');
    expect(res.billing.paid.amount).toBe('0');
    expect(res.transactions[0].billingState).toBe('PENDING');
    // Una anulada NO es una factura de ningún bucket: no se lista en el detalle de nadie.
    expect(res.billing.invoiced.invoices).toEqual([]);
    expect(res.billing.paid.invoices).toEqual([]);
  });

  it('un ciclo que no existe en el mapa (puntero colgado) cae en PENDIENTE, nunca en cobrado', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-fantasma', '900000')] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.pending.amount).toBe('900000');
    expect(res.billing.paid.amount).toBe('0');
  });

  // ── Detalle de las cards ────────────────────────────────────────────────────

  it('R3.1/R3.2 — COBRADO lista sus facturas con número, período, fecha de pago, importe e id para enlazar', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-paid', '12000000', 24)] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-paid', 'PAID', {
        sentAt: new Date('2026-07-01T12:00:00Z'),
        paidAt: new Date('2026-07-10T12:00:00Z'),
      }),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.paid.invoices).toHaveLength(1);
    expect(res.billing.paid.invoices[0]).toMatchObject({
      id: 'cyc-paid', // enlaza a /portal/billing?invoice=<id>
      invoiceNumber: 'FAC-2026-cyc-paid',
      amount: '12000000',
      hours: 24,
      currency: 'PYG',
      date: new Date('2026-07-10T12:00:00Z'), // la de PAGO, no la de envío
    });
  });

  it('R3.4 — FACTURADO también es navegable, y su fecha es la de ENVÍO (todavía no hay pago)', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-sent', '3100000', 6)] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-sent', 'SENT', { sentAt: new Date('2026-08-01T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.invoiced.invoices).toHaveLength(1);
    expect(res.billing.invoiced.invoices[0]).toMatchObject({
      invoiceNumber: 'FAC-2026-cyc-sent',
      date: new Date('2026-08-01T12:00:00Z'),
      amount: '3100000',
    });
  });

  it('R3.3 — el detalle NO lista borradores ni anulados-nunca-enviados (filtro de visibilidad de #61)', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo('cyc-draft', '4000000'),
      grupo('cyc-descartado', '700000'), // CANCELLED con sentAt null = borrador descartado
      grupo('cyc-paid', '12000000'),
    ] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-draft', 'DRAFT'),
      ciclo('cyc-descartado', 'CANCELLED', { sentAt: null }),
      ciclo('cyc-paid', 'PAID', { sentAt: new Date('2026-07-01T12:00:00Z'), paidAt: new Date('2026-07-10T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    const listados = [...res.billing.invoiced.invoices, ...res.billing.paid.invoices].map((i) => i.invoiceNumber);
    expect(listados).toEqual(['FAC-2026-cyc-paid']);
    // y el JSON completo tampoco los menciona por otro lado
    expect(JSON.stringify(res)).not.toContain('FAC-2026-cyc-draft');
    expect(JSON.stringify(res)).not.toContain('FAC-2026-cyc-descartado');
  });

  it('ordena las facturas de cada card por período, más reciente primero', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([
      grupo('cyc-jun', '1000000'),
      grupo('cyc-ago', '3000000'),
      grupo('cyc-jul', '2000000'),
    ] as never);
    const pagado = (id: string, mes: string) =>
      ciclo(id, 'PAID', {
        periodStart: new Date(`${mes}T03:00:00Z`),
        sentAt: new Date(`${mes}T12:00:00Z`),
        paidAt: new Date(`${mes}T12:00:00Z`),
      });
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      pagado('cyc-jun', '2026-06-01'),
      pagado('cyc-ago', '2026-08-01'),
      pagado('cyc-jul', '2026-07-01'),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.paid.invoices.map((i) => i.id)).toEqual(['cyc-ago', 'cyc-jul', 'cyc-jun']);
  });

  it('sin `portalBillingEnabled` los MONTOS salen igual pero no se lista ninguna factura', async () => {
    // /portal/billing rebota a /portal sin el flag: enlazar ahí sería mandar al cliente a una
    // puerta cerrada y mostrarle números de factura que su organización decidió no mostrarle.
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      contractedHours: 10,
      usedHours: 5,
      loanedHours: 0,
      currency: 'PYG',
      developmentHourlyRate: null,
      supportHourlyRate: null,
      portalBillingEnabled: false,
    } as never);
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-paid', '12000000')] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-paid', 'PAID', { sentAt: new Date('2026-07-01T12:00:00Z'), paidAt: new Date('2026-07-10T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.billing.paid.amount).toBe('12000000'); // su plata, sin gate (igual que el KPI de hoy)
    expect(res.billing.paid.invoices).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('FAC-2026-cyc-paid');
  });

  // ── Forma de las consultas ──────────────────────────────────────────────────

  it('los buckets salen de un AGREGADO sobre todo el historial, no de la ventana de 100 filas', async () => {
    // Lo COBRADO es lo VIEJO: es lo primero que se cae de un `take: 100` ordenado por createdAt
    // desc. Con la lista vacía, los buckets tienen que seguir siendo correctos.
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-paid', '12000000')] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([
      ciclo('cyc-paid', 'PAID', { sentAt: new Date('2026-07-01T12:00:00Z'), paidAt: new Date('2026-07-10T12:00:00Z') }),
    ] as never);

    const res = await service.getMyHours('user-1');

    expect(res.transactions).toEqual([]);
    expect(res.billing.paid.amount).toBe('12000000');

    const g = prisma.hoursTransaction.groupBy.mock.calls[0][0] as any;
    expect(g.by).toEqual(['billedCycleId']);
    expect(g.take).toBeUndefined(); // sin recorte
    expect(g.where).toMatchObject({ clientId: CLIENT, deletedAt: null, priceAmount: { not: null } });
    expect(g.where.type.in).toEqual(['USAGE', 'LOAN']); // mismo conjunto que la lista que se pinta
  });

  it('#55 — el join del ciclo no le pide campos internos a la base', async () => {
    await service.getMyHours('user-1');

    const arg = prisma.clientBillingCycle.findMany.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ clientId: CLIENT });
    for (const interno of ['notes', 'cancelReason', 'cancelledById', 'cancelledAt', 'closedById', 'closedAt', 'variablesBilling', 'organizationId', 'totalAmount', 'totalHours']) {
      expect(arg.select[interno]).toBeUndefined();
    }
    // #63 — El desglose del IVA tampoco se le pide a la base. La etiqueta del portal sale del MODO y
    // nada más; `taxRate`/`netAmount`/`taxAmount` son montos del documento que esta pantalla no pinta.
    for (const desglose of ['taxRate', 'netAmount', 'taxAmount']) {
      expect(arg.select[desglose]).toBeUndefined();
    }
    // y lo que sí se pide es lo mínimo para clasificar + pintar la factura
    expect(arg.select).toEqual({
      id: true,
      invoiceNumber: true,
      kind: true,
      periodStart: true,
      periodEnd: true,
      cutoffDate: true,
      currency: true,
      status: true,
      sentAt: true,
      paidAt: true,
      taxMode: true, // #63: el estampado de ESTE ciclo, único origen válido de la etiqueta de una factura
    });
  });

  it('#55 — `status` y `sentAt` se usan para clasificar pero no viajan crudos en el payload', async () => {
    prisma.hoursTransaction.groupBy.mockResolvedValue([grupo('cyc-draft', '4000000')] as never);
    prisma.clientBillingCycle.findMany.mockResolvedValue([ciclo('cyc-draft', 'DRAFT')] as never);
    prisma.hoursTransaction.findMany.mockResolvedValue([mov('tx-1', 'cyc-draft')] as never);

    const res = await service.getMyHours('user-1');

    expect((res.transactions[0] as any).billedCycle).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('DRAFT');
  });

  // ── #63 — Etiquetas de IVA: DOS ORÍGENES DISTINTOS ──────────────────────────
  //
  // Es toda la sección R8 en una frase: el modo de Pendiente sale del CLIENTE (no hay documento
  // todavía) y el de cada factura sale de SU PROPIO ESTAMPADO. Confundirlos es el error fácil, y el
  // síntoma sería una factura vieja mostrando el modo que el cliente tiene HOY.
  describe('etiquetas de IVA (#63)', () => {
    /** Cliente con un modo de IVA configurado HOY (el que etiqueta sólo a Pendiente). */
    function clienteConModo(taxMode: string | null) {
      prisma.client.findFirst.mockResolvedValue({
        id: CLIENT,
        contractedHours: 10,
        usedHours: 5,
        loanedHours: 0,
        currency: 'PYG',
        developmentHourlyRate: null,
        supportHourlyRate: null,
        portalBillingEnabled: true,
        taxMode,
      } as never);
    }

    it('EL TEST DE LA SECCIÓN: dos facturas con modos distintos → CADA UNA muestra el suyo, y la que se emitió sin IVA no muestra ninguno', async () => {
      // El cliente cambió a INCLUDED en algún momento; sus facturas viejas conservan lo suyo.
      clienteConModo('INCLUDED');
      prisma.hoursTransaction.groupBy.mockResolvedValue([
        grupo('cyc-vieja', '1000000'),
        grupo('cyc-nueva', '2000000'),
        grupo('cyc-preiva', '3000000'),
      ] as never);
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        ciclo('cyc-vieja', 'PAID', { taxMode: 'EXCLUDED', paidAt: new Date('2026-06-10T12:00:00Z') }),
        ciclo('cyc-nueva', 'PAID', { taxMode: 'INCLUDED', paidAt: new Date('2026-07-10T12:00:00Z') }),
        ciclo('cyc-preiva', 'PAID', { taxMode: null, paidAt: new Date('2026-05-10T12:00:00Z') }),
      ] as never);

      const res = await service.getMyHours('user-1');

      const porId = new Map(res.billing.paid.invoices.map((i) => [i.id, i.taxMode]));
      expect(porId.get('cyc-vieja')).toBe('EXCLUDED'); // ← el SUYO, no el del cliente (INCLUDED)
      expect(porId.get('cyc-nueva')).toBe('INCLUDED');
      expect(porId.get('cyc-preiva')).toBeNull(); // anterior a #63 → SIN etiqueta, no hereda
    });

    it('Pendiente lleva el modo ACTUAL DEL CLIENTE (todavía no hay ningún documento emitido)', async () => {
      clienteConModo('EXCLUDED');
      prisma.hoursTransaction.groupBy.mockResolvedValue([grupo(null, '4000000')] as never);

      const res = await service.getMyHours('user-1');

      expect(res.billing.pending.taxMode).toBe('EXCLUDED');
      expect(res.billing.pending.amount).toBe('4000000');
    });

    it('cliente sin IVA → Pendiente sin modo: la pantalla queda idéntica a como la dejó #62', async () => {
      clienteConModo(null);
      prisma.hoursTransaction.groupBy.mockResolvedValue([grupo(null, '4000000'), grupo('cyc-1', '1000000')] as never);
      prisma.clientBillingCycle.findMany.mockResolvedValue([
        ciclo('cyc-1', 'SENT', { taxMode: null, sentAt: new Date('2026-07-05T12:00:00Z') }),
      ] as never);

      const res = await service.getMyHours('user-1');

      expect(res.billing.pending.taxMode).toBeNull();
      expect(res.billing.invoiced.invoices[0].taxMode).toBeNull();
    });

    it('NINGÚN NÚMERO cambia: prender el IVA en el cliente no mueve los tres buckets (R8.1)', async () => {
      const stubs = () => {
        prisma.hoursTransaction.groupBy.mockResolvedValue([
          grupo(null, '4000000'),
          grupo('cyc-sent', '1000000'),
          grupo('cyc-paid', '2000000'),
        ] as never);
        prisma.clientBillingCycle.findMany.mockResolvedValue([
          ciclo('cyc-sent', 'SENT', { sentAt: new Date('2026-07-05T12:00:00Z') }),
          ciclo('cyc-paid', 'PAID', { paidAt: new Date('2026-07-20T12:00:00Z') }),
        ] as never);
      };

      clienteConModo(null);
      stubs();
      const sinIva = await service.getMyHours('user-1');

      clienteConModo('EXCLUDED');
      stubs();
      const conIva = await service.getMyHours('user-1');

      // Pendiente sigue siendo NETO (sale de `priceAmount`) y las otras dos de `totalAmount`.
      // La etiqueta es lo ÚNICO que se agrega; el dinero no se toca en ninguna de las tres.
      expect(conIva.billing.pending.amount).toBe(sinIva.billing.pending.amount);
      expect(conIva.billing.invoiced.amount).toBe(sinIva.billing.invoiced.amount);
      expect(conIva.billing.paid.amount).toBe(sinIva.billing.paid.amount);
      expect(conIva.totalAmount).toBe(sinIva.totalAmount);
    });
  });
});
