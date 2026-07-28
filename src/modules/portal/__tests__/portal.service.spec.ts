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
