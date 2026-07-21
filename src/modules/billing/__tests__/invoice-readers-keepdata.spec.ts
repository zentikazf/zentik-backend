import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../database/prisma.service';
import { ReportService, MetricsAggregator } from '../../report/report.service';
import { SubscriptionService } from '../../subscription/subscription.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { ProjectService } from '../../project/project.service';
import { ProjectBudgetService } from '../../project/project-budget.service';

/**
 * F3 (#27) — KEEP-DATA: apagar la generación de facturas por proyecto NO debe romper
 * ninguno de los 4 readers que siguen leyendo la tabla `invoices` histórica.
 *
 * Defensa en profundidad: estos tests lockean el histórico para que un cambio futuro no
 * lo rompa en silencio (feedback_senior_anticipation). Prisma MOCKEADO — nunca toca la DB.
 *
 * R10 → report.getProfitability (SQL raw sobre `invoices`).
 * R11 → subscription.getInvoices (prisma.invoice.findMany/count).
 * R12 → project.findById expone `_count.invoices`.
 * R13 → project-budget.getAlcance suma `invoices` PAID en `invoiced`.
 */
describe('KEEP-DATA — los 4 readers históricos siguen leyendo `invoices` (F3 #27)', () => {
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
  });

  it('report.getProfitability lee `invoices` via $queryRaw y devuelve total_invoiced/total_paid (R10)', async () => {
    const service = new ReportService(prisma, mockDeep<MetricsAggregator>());
    prisma.$queryRaw.mockResolvedValue([
      {
        project_id: 'p1',
        project_name: 'Proyecto Uno',
        total_hours: 10,
        total_invoiced: 500,
        total_paid: 300,
      },
    ] as never);

    const res = await service.getProfitability('org-1');

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(res.projects[0]).toMatchObject({
      projectId: 'p1',
      totalInvoiced: 500,
      totalPaid: 300,
    });
  });

  it('subscription.getInvoices lee prisma.invoice.findMany/count y devuelve data/total (R11)', async () => {
    const service = new SubscriptionService(
      prisma,
      mockDeep<RedisService>(),
      mockDeep<EventEmitter2>(),
    );
    prisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1' }] as never);
    prisma.invoice.count.mockResolvedValue(1 as never);

    const res = await service.getInvoices('org-1', 1);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: { organizationId: 'org-1' } });
    expect(res.data).toHaveLength(1);
    expect(res.meta.total).toBe(1);
  });

  it('project.findById expone `_count.invoices` en el include y en la respuesta (R12)', async () => {
    const service = new ProjectService(prisma, mockDeep<EventEmitter2>());
    prisma.project.findFirst.mockResolvedValue({ id: 'p1', _count: { invoices: 3 } } as never);
    prisma.suggestion.count.mockResolvedValue(0 as never);
    prisma.task.count.mockResolvedValue(0 as never);
    prisma.task.groupBy.mockResolvedValue([] as never);

    const res = await service.findById('p1');

    expect(prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: { select: expect.objectContaining({ invoices: true }) },
        }),
      }),
    );
    expect((res as { _count: { invoices: number } })._count.invoices).toBe(3);
  });

  it('project-budget.getAlcance suma `invoices` PAID en `invoiced` (R13)', async () => {
    const service = new ProjectBudgetService(prisma, mockDeep<ProjectService>());
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1' } as never);
    prisma.project.findMany.mockResolvedValue([
      {
        id: 'p1',
        name: 'Proyecto Uno',
        status: 'DEVELOPMENT',
        startDate: null,
        endDate: null,
        billingMonth: null,
        client: null,
        responsible: null,
        budget: 0,
        investment: 0,
        invoices: [{ total: 200 }, { total: 300 }],
        budgetItems: [],
        _count: { tasks: 0 },
        tasks: [],
      },
    ] as never);

    const res = await service.getAlcance('org-1');

    // El include pide explícitamente las invoices con status PAID.
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          invoices: expect.objectContaining({ where: { status: 'PAID' } }),
        }),
      }),
    );
    expect(res.data[0].invoiced).toBe(500);
    expect(res.totals.invoiced).toBe(500);
  });
});
