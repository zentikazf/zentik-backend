import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import {
  ClientBillingPdfService,
  buildInvoiceModel,
  buildCreditNoteModel,
  fmtMoney,
} from '../client-billing-pdf.service';
import {
  ClientBillingService,
  CycleDto,
  CycleTransactionLine,
  CycleTransactionsResponse,
} from '../client-billing.service';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Tests del PDF de la factura (#39 / H8e). El modelo intermedio (`buildInvoiceModel`) es PURO y se
 * verifica sin parsear el binario; `generateInvoicePdf` se verifica end-to-end con Prisma + billing
 * MOCKEADOS (nunca toca DB). No hay migración.
 */
describe('ClientBillingPdfService (#39 H8e)', () => {
  const ORG = 'org-1';
  const CLIENT = 'client-1';
  const CYCLE = 'cyc-1';

  function makeCycle(over: Partial<CycleDto> = {}): CycleDto {
    return {
      id: CYCLE,
      status: 'DRAFT',
      kind: 'MONTH',
      invoiceNumber: 'FAC-2026-00007',
      periodStart: new Date('2026-07-01T03:00:00Z'), // Asunción 2026-07-01 00:00
      periodEnd: new Date('2026-08-01T02:59:59.999Z'), // Asunción 2026-07-31 23:59
      cutoffDate: new Date('2026-08-01T02:59:59.999Z'),
      totalHours: 3,
      totalAmount: '150000',
      currency: 'PYG',
      notes: null,
      closedAt: new Date('2026-07-31T12:00:00Z'),
      sentAt: null,
      paidAt: null,
      cancelReason: null,
      cancelledAt: null,
      variablesBilling: null,
      createdAt: new Date('2026-07-31T12:00:00Z'),
      ...over,
    };
  }

  function makeLine(over: Partial<CycleTransactionLine> = {}): CycleTransactionLine {
    return {
      id: 'ht-1',
      createdAt: new Date('2026-07-10T12:00:00Z'),
      workedOn: new Date(Date.UTC(2026, 6, 10)),
      workedMonth: '2026-07',
      atrasada: false,
      type: 'USAGE',
      hours: 1.5,
      note: 'trabajo',
      priceAmount: '75000',
      priceRate: '50000',
      priceCurrency: 'PYG',
      task: { id: 't-1', title: 'Ajuste de landing', type: 'SUPPORT' },
      ...over,
    };
  }

  // ── buildInvoiceModel (puro) ──────────────────────────────────────────────
  describe('buildInvoiceModel', () => {
    it('mapea header, período (mes único), líneas y total; sin banda de anulación', () => {
      const model = buildInvoiceModel({
        cycle: makeCycle(),
        clientName: 'Cliente X',
        org: { name: 'Agencia Y', supportEmail: 'hola@agencia.py' },
        transactions: [makeLine({ id: 'a', type: 'USAGE' }), makeLine({ id: 'b', type: 'LOAN' })],
        grupos: [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '150000', horas: 3 }],
      });

      expect(model.invoiceNumber).toBe('FAC-2026-00007');
      expect(model.orgName).toBe('Agencia Y');
      expect(model.clientName).toBe('Cliente X');
      expect(model.periodLabel).toMatch(/Julio.*2026/); // mes único (start === end); ICU es-PY puede intercalar "de"
      expect(model.cutoffLabel).not.toBeNull();
      expect(model.cancelled).toBeNull();
      expect(model.groups).toHaveLength(1);
      expect(model.groups[0].showHeader).toBe(false); // sin desglose = sin header de mes
      expect(model.groups[0].lines).toHaveLength(2);
      expect(model.groups[0].lines[0].tarifa).toContain('50.000'); // priceRate expuesto
      expect(model.groups[0].lines[1].tipo).toBe('Fuera de cupo'); // LOAN
      expect(model.totalMonto).toContain('150.000'); // es-PY: separador de miles '.'
      expect(model.totalHoras).toBe('3.00h');
    });

    it('factura anulada: banda ANULADA con el motivo y la fecha', () => {
      const model = buildInvoiceModel({
        cycle: makeCycle({
          status: 'CANCELLED',
          cancelReason: 'Cargada con tarifa equivocada',
          cancelledAt: new Date('2026-07-31T15:00:00Z'),
        }),
        clientName: 'Cliente X',
        org: { name: 'Agencia Y', supportEmail: null },
        transactions: [makeLine()],
        grupos: [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '75000', horas: 1.5 }],
      });

      expect(model.cancelled).not.toBeNull();
      expect(model.cancelled?.reason).toBe('Cargada con tarifa equivocada');
      expect(model.cancelled?.at).not.toBeNull();
    });

    it('factura acumulada: rango de meses en el período + desglose (showHeader) por grupo', () => {
      const model = buildInvoiceModel({
        cycle: makeCycle({
          kind: 'ACCUMULATED',
          periodStart: new Date('2026-05-01T03:00:00Z'), // Asunción mayo 1
          periodEnd: new Date('2026-07-01T02:59:59.999Z'), // Asunción junio 30 23:59
          cutoffDate: new Date('2026-07-01T02:59:59.999Z'),
        }),
        clientName: 'Cliente X',
        org: { name: 'Agencia Y', supportEmail: null },
        transactions: [
          makeLine({ id: 'm', workedMonth: '2026-05', workedOn: new Date(Date.UTC(2026, 4, 20)) }),
          makeLine({ id: 'j', workedMonth: '2026-06', workedOn: new Date(Date.UTC(2026, 5, 12)) }),
        ],
        grupos: [
          { workedMonth: '2026-05', label: 'Mayo 2026', subtotal: '75000', horas: 1.5 },
          { workedMonth: '2026-06', label: 'Junio 2026', subtotal: '75000', horas: 1.5 },
        ],
      });

      expect(model.periodLabel).toContain('Mayo');
      expect(model.periodLabel).toContain('Junio');
      expect(model.periodLabel).toContain('–'); // rango
      expect(model.groups).toHaveLength(2);
      expect(model.groups.every((g) => g.showHeader)).toBe(true);
      expect(model.groups[0].lines).toHaveLength(1);
      expect(model.groups[1].lines).toHaveLength(1);
    });

    it('fmtMoney: null → "—"; string numérico → es-PY 0 decimales', () => {
      expect(fmtMoney(null, 'PYG')).toBe('—');
      expect(fmtMoney('0', 'PYG')).toContain('0');
      expect(fmtMoney('150000', 'PYG')).toContain('150.000');
    });
  });

  // ── generateInvoicePdf (end-to-end, deps mockeadas) ───────────────────────
  describe('generateInvoicePdf', () => {
    let prisma: DeepMockProxy<PrismaService>;
    let billing: DeepMockProxy<ClientBillingService>;
    let service: ClientBillingPdfService;

    beforeEach(() => {
      prisma = mockDeep<PrismaService>();
      billing = mockDeep<ClientBillingService>();
      service = new ClientBillingPdfService(prisma, billing);

      const response: CycleTransactionsResponse = {
        cycle: makeCycle(),
        transactions: [makeLine({ id: 'a' }), makeLine({ id: 'b', type: 'LOAN' })],
        grupos: [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '150000', horas: 3 }],
      };
      billing.getCycleTransactions.mockResolvedValue(response);
      prisma.client.findUnique.mockResolvedValue({ name: 'Cliente X' } as never);
      prisma.organization.findUnique.mockResolvedValue({
        name: 'Agencia Y',
        logo: null,
        supportEmail: 'hola@agencia.py',
      } as never);
    });

    it('genera un Buffer PDF no vacío + filename FAC-*.pdf', async () => {
      const { buffer, filename } = await service.generateInvoicePdf(ORG, CLIENT, CYCLE);

      expect(filename).toBe('FAC-2026-00007.pdf');
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // firma de PDF válido
      expect(billing.getCycleTransactions).toHaveBeenCalledWith(ORG, CLIENT, CYCLE);
    });

    it('genera el PDF también para una factura anulada (con motivo)', async () => {
      billing.getCycleTransactions.mockResolvedValue({
        cycle: makeCycle({ status: 'CANCELLED', cancelReason: 'Duplicada', cancelledAt: new Date() }),
        transactions: [makeLine()],
        grupos: [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '75000', horas: 1.5 }],
      });

      const { buffer } = await service.generateInvoicePdf(ORG, CLIENT, CYCLE);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(buffer.length).toBeGreaterThan(0);
    });

    // #63 — El bloque de totales pasó de una altura fija a una variable (tres líneas con IVA). Se
    // renderiza con MUCHAS líneas para forzar el salto de página y comprobar que el documento
    // sigue saliendo entero: el riesgo del cambio es que el bloque se parta o pise el pie (R6.5).
    it('con IVA y suficientes líneas para saltar de página, el PDF sigue saliendo válido', async () => {
      const muchas = Array.from({ length: 60 }, (_, i) => makeLine({ id: `ht-${i}` }));
      billing.getCycleTransactions.mockResolvedValue({
        cycle: makeCycle({
          totalAmount: '1000000',
          taxRate: '0.1000',
          taxMode: 'INCLUDED',
          netAmount: '909090.91',
          taxAmount: '90909.09',
        }),
        transactions: muchas,
        grupos: [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '1000000', horas: 90 }],
      });

      const { buffer } = await service.generateInvoicePdf(ORG, CLIENT, CYCLE);
      expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  // ── #63 — IVA en el PDF ────────────────────────────────────────────────────
  //
  // Los tests verifican el MODELO (puro), no el binario: es la separación que este archivo declara.
  describe('IVA (#63)', () => {
    const grupos = [{ workedMonth: '2026-07', label: 'Julio 2026', subtotal: '150000', horas: 3 }];
    const comunes = {
      clientName: 'Cliente X',
      org: { name: 'Agencia Y', supportEmail: 'hola@agencia.py' },
      transactions: [makeLine()],
      grupos,
    };

    it('NO-REGRESIÓN: sin IVA el modelo es IDÉNTICO al de antes de #63 (los tres campos en null)', () => {
      const model = buildInvoiceModel({ cycle: makeCycle(), ...comunes });

      // Los tres nuevos en null → el render dibuja UNA sola línea TOTAL, como siempre.
      expect(model.subtotalMonto).toBeNull();
      expect(model.ivaLabel).toBeNull();
      expect(model.ivaMonto).toBeNull();
      // Y nada del resto se movió.
      expect(model.totalMonto).toBe(fmtMoney('150000', 'PYG'));
      expect(model.totalHoras).toBe('3.00h');
    });

    it('con IVA arma las tres líneas pre-formateadas y el TOTAL sigue siendo lo que el cliente paga', () => {
      const model = buildInvoiceModel({
        cycle: makeCycle({
          totalAmount: '1000000',
          taxRate: '0.1000',
          taxMode: 'INCLUDED',
          netAmount: '909090.91',
          taxAmount: '90909.09',
        }),
        ...comunes,
      });

      expect(model.subtotalMonto).toBe(fmtMoney('909090.91', 'PYG')); // 909.091 (es-PY, 0 decimales)
      expect(model.ivaLabel).toBe('IVA (10%)');
      expect(model.ivaMonto).toBe(fmtMoney('90909.09', 'PYG')); // 90.909
      expect(model.totalMonto).toBe(fmtMoney('1000000', 'PYG')); // 1.000.000
    });

    it('la etiqueta soporta tasas no enteras (5%, 10,5%)', () => {
      const conTasa = (rate: string) =>
        buildInvoiceModel({
          cycle: makeCycle({ taxRate: rate, taxMode: 'EXCLUDED', netAmount: '100', taxAmount: '10' }),
          ...comunes,
        }).ivaLabel;

      expect(conTasa('0.0500')).toBe('IVA (5%)');
      expect(conTasa('0.1050')).toBe('IVA (10,5%)');
    });

    it('un ciclo con rate pero sin net/tax (dato incompleto) NO dibuja el desglose', () => {
      // Fail-safe: antes de mostrar un "Subtotal —" al cliente, se cae a la línea única de siempre.
      const model = buildInvoiceModel({
        cycle: makeCycle({ taxRate: '0.1000', taxMode: 'EXCLUDED' }),
        ...comunes,
      });
      expect(model.subtotalMonto).toBeNull();
      expect(model.ivaMonto).toBeNull();
    });

    it('la NC hereda el desglose de su factura, en NEGATIVO', () => {
      const model = buildCreditNoteModel({
        creditNote: {
          number: 'NC-2026-00001',
          reason: 'Tarifa equivocada',
          currency: 'PYG',
          totalAmount: new Prisma.Decimal('-110000'),
          totalHours: -2,
          issuedAt: new Date('2026-08-01T12:00:00Z'),
          createdAt: new Date('2026-08-01T12:00:00Z'),
          appliesTo: { invoiceNumber: 'FAC-2026-00007' },
          taxRate: new Prisma.Decimal('0.1000'),
          netAmount: new Prisma.Decimal('-100000'),
          taxAmount: new Prisma.Decimal('-10000'),
        },
        lines: [
          {
            hours: 2,
            priceAmount: new Prisma.Decimal('100000'),
            priceRate: new Prisma.Decimal('50000'),
            priceCurrency: 'PYG',
            workedOn: new Date(Date.UTC(2026, 6, 10)),
            description: 'Ajuste',
          },
        ],
        clientName: 'Cliente X',
        org: { name: 'Agencia Y', supportEmail: null },
      });

      expect(model.docTitle).toBe('NOTA DE CRÉDITO');
      expect(model.subtotalMonto).toBe(fmtMoney('-100000', 'PYG'));
      expect(model.ivaLabel).toBe('IVA (10%)');
      expect(model.ivaMonto).toBe(fmtMoney('-10000', 'PYG'));
      expect(model.totalMonto).toBe(fmtMoney('-110000', 'PYG'));
    });

    it('una NC sobre una factura sin IVA no dibuja desglose (como todas las anteriores a #63)', () => {
      const model = buildCreditNoteModel({
        creditNote: {
          number: 'NC-2026-00002',
          reason: 'x',
          currency: 'PYG',
          totalAmount: new Prisma.Decimal('-100000'),
          totalHours: -2,
          issuedAt: new Date('2026-08-01T12:00:00Z'),
          createdAt: new Date('2026-08-01T12:00:00Z'),
          appliesTo: { invoiceNumber: 'FAC-2026-00007' },
        },
        lines: [
          {
            hours: 2,
            priceAmount: new Prisma.Decimal('100000'),
            priceRate: null,
            priceCurrency: 'PYG',
            workedOn: new Date(Date.UTC(2026, 6, 10)),
            description: 'Ajuste',
          },
        ],
        clientName: 'Cliente X',
        org: null,
      });

      expect(model.subtotalMonto).toBeNull();
      expect(model.ivaLabel).toBeNull();
      expect(model.ivaMonto).toBeNull();
    });
  });
});
