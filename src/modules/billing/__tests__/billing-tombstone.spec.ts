import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BillingController } from '../billing.controller';
import { InvoiceService } from '../billing.service';
import { PrismaService } from '../../../database/prisma.service';

/**
 * F3 (#27) — tombstone 410 de `POST projects/:projectId/invoices`.
 *
 * R3: la generación de facturas por proyecto quedó deprecada ⇒ el handler responde
 * `410 Gone` con código `PROJECT_INVOICING_DEPRECATED` y NO crea ninguna fila Invoice/InvoiceItem
 * (KEEP-DATA: el histórico se conserva, pero no se genera nada nuevo).
 *
 * Prisma MOCKEADO (jest-mock-extended) — nunca toca la DB.
 */
describe('BillingController — tombstone 410 de POST projects/:id/invoices (F3 #27)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let controller: BillingController;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    // InvoiceService real con Prisma mockeado: prueba que el tombstone NO llega a la capa de datos.
    const invoiceService = new InvoiceService(prisma, mockDeep<EventEmitter2>());
    controller = new BillingController(invoiceService);
  });

  it('generate() lanza AppException 410 PROJECT_INVOICING_DEPRECATED sin tocar la DB (R3)', () => {
    let thrown: unknown;
    try {
      controller.generate();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toMatchObject({
      code: 'PROJECT_INVOICING_DEPRECATED',
      statusCode: HttpStatus.GONE, // 410
    });
    // KEEP-DATA: el tombstone es puro, jamás intenta crear Invoice/InvoiceItem.
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
});
