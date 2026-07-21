import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateInvoiceDto } from './dto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listByProject(projectId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { projectId },
        include: {
          createdBy: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.invoice.count({ where: { projectId } }),
    ]);

    return { data, total, page, limit };
  }

  async getById(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: true,
        project: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!invoice) {
      throw new AppException('La factura no existe', 'INVOICE_NOT_FOUND', 404, { invoiceId });
    }

    return invoice;
  }

  async update(invoiceId: string, dto: UpdateInvoiceDto) {
    await this.getById(invoiceId);

    const updateData: Record<string, unknown> = {};
    if (dto.status) updateData.status = dto.status;
    if (dto.notes !== undefined) updateData.notes = dto.notes;
    if (dto.dueDate) updateData.dueDate = new Date(dto.dueDate);

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: updateData,
      include: {
        items: true,
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async send(invoiceId: string) {
    const invoice = await this.getById(invoiceId);

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'SENT' },
      include: {
        items: true,
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.eventEmitter.emit('invoice.sent', {
      ...domainEvent('invoice.sent', 'invoice', invoice.id, invoice.organizationId, undefined, { invoiceNumber: invoice.invoiceNumber }),
      data: { invoiceNumber: invoice.invoiceNumber },
    });

    this.logger.log(`Invoice sent: ${invoice.invoiceNumber}`);
    return updated;
  }

  async markAsPaid(invoiceId: string) {
    const invoice = await this.getById(invoiceId);

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
      },
      include: {
        items: true,
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.eventEmitter.emit('invoice.paid', {
      ...domainEvent('invoice.paid', 'invoice', invoice.id, invoice.organizationId, undefined, { invoiceNumber: invoice.invoiceNumber, total: Number(invoice.total) }),
      data: { invoiceNumber: invoice.invoiceNumber, total: invoice.total },
    });

    this.logger.log(`Invoice marked as paid: ${invoice.invoiceNumber}`);
    return updated;
  }

  async generatePdf(invoiceId: string) {
    const invoice = await this.getById(invoiceId);

    // Placeholder: In production, use a PDF library like pdfkit or puppeteer
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      message: 'PDF generation placeholder - integrate pdfkit or puppeteer for production',
      data: {
        organization: invoice.organization,
        project: invoice.project,
        items: invoice.items,
        subtotal: invoice.subtotal,
        taxRate: invoice.taxRate,
        taxAmount: invoice.taxAmount,
        total: invoice.total,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
      },
    };
  }

  async getBillingSummary(orgId: string) {
    const [totalInvoiced, totalPaid, totalPending, invoicesByStatus] = await Promise.all([
      this.prisma.invoice.aggregate({
        where: { organizationId: orgId },
        _sum: { total: true },
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId: orgId, status: 'PAID' },
        _sum: { total: true },
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId: orgId, status: { in: ['DRAFT', 'SENT', 'OVERDUE'] } },
        _sum: { total: true },
      }),
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: { organizationId: orgId },
        _count: { id: true },
        _sum: { total: true },
      }),
    ]);

    return {
      totalInvoiced: totalInvoiced._sum.total || new Decimal(0),
      totalPaid: totalPaid._sum.total || new Decimal(0),
      totalPending: totalPending._sum.total || new Decimal(0),
      byStatus: invoicesByStatus.map((group) => ({
        status: group.status,
        count: group._count.id,
        total: group._sum.total || new Decimal(0),
      })),
    };
  }

}
