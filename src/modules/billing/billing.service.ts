import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generate(projectId: string, createdById: string, dto: CreateInvoiceDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true, name: true },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404, { projectId });
    }

    const timeEntries = await this.prisma.timeEntry.findMany({
      where: {
        task: { projectId },
        billable: true,
        startTime: { gte: new Date(dto.periodStart) },
        endTime: { lte: new Date(dto.periodEnd) },
      },
      include: {
        task: { select: { id: true, title: true, hourlyRate: true } },
        user: { select: { name: true } },
      },
    });

    const invoiceNumber = await this.generateInvoiceNumber(project.organizationId);

    const fallbackRate = dto.defaultHourlyRate ?? 0;

    // Group time entries by task, using per-task hourlyRate
    const taskGroups = new Map<string, { taskId: string; description: string; totalMinutes: number; rate: number }>();
    for (const entry of timeEntries) {
      const key = entry.taskId;
      const existing = taskGroups.get(key);
      const duration = entry.duration || 0;
      if (existing) {
        existing.totalMinutes += duration;
      } else {
        const taskRate = entry.task.hourlyRate ? Number(entry.task.hourlyRate) : fallbackRate;
        taskGroups.set(key, {
          taskId: entry.task.id,
          description: entry.task.title,
          totalMinutes: duration,
          rate: taskRate,
        });
      }
    }

    const items = Array.from(taskGroups.values()).map((group) => {
      const hours = group.totalMinutes / 60;
      return {
        description: group.description,
        quantity: new Decimal(hours.toFixed(2)),
        unitPrice: new Decimal(group.rate),
        amount: new Decimal((hours * group.rate).toFixed(2)),
        taskId: group.taskId,
      };
    });

    const subtotal = items.reduce(
      (sum, item) => sum.add(item.amount),
      new Decimal(0),
    );
    const taxRate = new Decimal(0);
    const taxAmount = subtotal.mul(taxRate).div(100);
    const total = subtotal.add(taxAmount);

    const invoice = await this.prisma.invoice.create({
      data: {
        organizationId: project.organizationId,
        projectId,
        invoiceNumber,
        status: 'DRAFT',
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        subtotal,
        taxRate,
        taxAmount,
        total,
        currency: 'PYG',
        notes: dto.notes || null,
        createdById,
        items: {
          create: items,
        },
      },
      include: {
        items: true,
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    this.eventEmitter.emit('invoice.generated', {
      ...domainEvent('invoice.generated', 'invoice', invoice.id, project.organizationId, createdById, { invoiceNumber: invoice.invoiceNumber, total: Number(invoice.total) }),
      data: { invoiceNumber: invoice.invoiceNumber, total: invoice.total },
    });

    this.logger.log(`Invoice generated: ${invoice.invoiceNumber} for project ${projectId}`);
    return invoice;
  }

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

  private async generateInvoiceNumber(organizationId: string): Promise<string> {
    const count = await this.prisma.invoice.count({
      where: { organizationId },
    });
    const year = new Date().getFullYear();
    const sequence = String(count + 1).padStart(5, '0');
    return `INV-${year}-${sequence}`;
  }
}

@Injectable()
export class InvoiceGeneratorService {
  private readonly logger = new Logger(InvoiceGeneratorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async calculateFromTimeEntries(
    projectId: string,
    periodStart: Date,
    periodEnd: Date,
    hourlyRate: number,
  ) {
    const timeEntries = await this.prisma.timeEntry.findMany({
      where: {
        task: { projectId },
        billable: true,
        startTime: { gte: periodStart },
        endTime: { lte: periodEnd },
      },
      include: {
        task: { select: { id: true, title: true } },
        user: { select: { id: true, name: true } },
      },
    });

    const groupedByUser = new Map<
      string,
      { userName: string; totalMinutes: number; tasks: string[] }
    >();

    for (const entry of timeEntries) {
      const key = entry.userId;
      const existing = groupedByUser.get(key);
      const duration = entry.duration || 0;
      if (existing) {
        existing.totalMinutes += duration;
        if (!existing.tasks.includes(entry.task.title)) {
          existing.tasks.push(entry.task.title);
        }
      } else {
        groupedByUser.set(key, {
          userName: entry.user.name,
          totalMinutes: duration,
          tasks: [entry.task.title],
        });
      }
    }

    const lineItems = Array.from(groupedByUser.values()).map((group) => {
      const hours = group.totalMinutes / 60;
      return {
        description: `${group.userName} - ${group.tasks.join(', ')}`,
        hours: parseFloat(hours.toFixed(2)),
        rate: hourlyRate,
        amount: parseFloat((hours * hourlyRate).toFixed(2)),
      };
    });

    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);

    return {
      lineItems,
      subtotal,
      totalHours: lineItems.reduce((sum, item) => sum + item.hours, 0),
      periodStart,
      periodEnd,
    };
  }
}
