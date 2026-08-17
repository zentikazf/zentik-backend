import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PortalService } from '../portal.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { FileService } from '../../file/file.service';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { OutboxService } from '../../sync/outbox.service';
import { ClientBillingPdfService } from '../../client-billing/client-billing-pdf.service';

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

  it('scopea por el cliente del usuario y filtra status a SENT/PAID/CANCELLED (sin DRAFT)', async () => {
    prisma.clientBillingCycle.findMany.mockResolvedValue([] as never);

    await service.getMyInvoices('user-1');

    expect(prisma.clientBillingCycle.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.clientBillingCycle.findMany.mock.calls[0][0] as any;
    expect(arg.where.clientId).toBe(CLIENT);
    expect(arg.where.status.in).toEqual(['SENT', 'PAID', 'CANCELLED']);
    expect(arg.where.status.in).not.toContain('DRAFT');
    expect(arg.orderBy).toEqual({ periodStart: 'desc' });
    // el select no expone notas internas del staff
    expect(arg.select.notes).toBeUndefined();
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
  });

  it('incluye la línea de la nota de crédito (no infiere desde la fila espejo)', async () => {
    prisma.hoursTransaction.findMany.mockResolvedValue([] as never);

    await service.getMyHours('user-1');

    const arg = prisma.hoursTransaction.findMany.mock.calls[0][0] as any;
    // el número de la NC sale de la relación, no de parsear el `note` de ninguna fila
    expect(arg.include.creditedByLine.select).toEqual({
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
      },
    ]);
    // el KPI "Pendiente de facturar" no cambia: sigue sumando lo que tiene precio y no fue facturado
    expect(res.totalAmount).toBe(300000);
  });
});
