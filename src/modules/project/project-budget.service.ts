import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  AppException,
  OrganizationNotFoundException,
} from '../../common/filters/app-exception';
import { ProjectService } from './project.service';
import { CreateBudgetItemDto, UpdateBudgetItemDto } from './dto/budget-item.dto';

@Injectable()
export class ProjectBudgetService {
  private readonly logger = new Logger(ProjectBudgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectService: ProjectService,
  ) {}

  async getBudgetItems(projectId: string) {
    await this.projectService.findById(projectId);

    const items = await this.prisma.budgetItem.findMany({
      where: { projectId },
      orderBy: { order: 'asc' },
    });

    const total = items.reduce((sum, item) => sum + Number(item.amount), 0);

    return { items, total };
  }

  async createBudgetItem(projectId: string, dto: CreateBudgetItemDto) {
    await this.projectService.findById(projectId);

    const hours = dto.hours ?? 0;
    const hourlyRate = dto.hourlyRate ?? 0;
    const amount = hours * hourlyRate;

    const maxOrder = await this.prisma.budgetItem.aggregate({
      where: { projectId },
      _max: { order: true },
    });

    const item = await this.prisma.budgetItem.create({
      data: {
        projectId,
        description: dto.description,
        category: dto.category,
        hours,
        hourlyRate,
        amount,
        order: (maxOrder._max.order ?? -1) + 1,
      },
    });

    return item;
  }

  async updateBudgetItem(projectId: string, itemId: string, dto: UpdateBudgetItemDto) {
    const item = await this.prisma.budgetItem.findFirst({
      where: { id: itemId, projectId },
    });

    if (!item) {
      throw new AppException('El item de presupuesto no existe', 'BUDGET_ITEM_NOT_FOUND', 404, { itemId });
    }

    const hours = dto.hours !== undefined ? dto.hours : Number(item.hours);
    const hourlyRate = dto.hourlyRate !== undefined ? dto.hourlyRate : Number(item.hourlyRate);
    const amount = hours * hourlyRate;

    const updated = await this.prisma.budgetItem.update({
      where: { id: itemId },
      data: {
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.hours !== undefined && { hours: dto.hours }),
        ...(dto.hourlyRate !== undefined && { hourlyRate: dto.hourlyRate }),
        amount,
      },
    });

    return updated;
  }

  async deleteBudgetItem(projectId: string, itemId: string) {
    const item = await this.prisma.budgetItem.findFirst({
      where: { id: itemId, projectId },
    });

    if (!item) {
      throw new AppException('El item de presupuesto no existe', 'BUDGET_ITEM_NOT_FOUND', 404, { itemId });
    }

    await this.prisma.budgetItem.delete({ where: { id: itemId } });
  }

  async reorderBudgetItems(projectId: string, itemIds: string[]) {
    await this.projectService.findById(projectId);

    await this.prisma.$transaction(
      itemIds.map((id, index) =>
        this.prisma.budgetItem.update({
          where: { id },
          data: { order: index },
        }),
      ),
    );

    return { reordered: true };
  }

  async getAlcance(orgId: string, filters?: { clientId?: string; status?: string; billingMonth?: string }) {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      throw new OrganizationNotFoundException(orgId);
    }

    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      status: { not: 'COMPLETED' },
    };

    if (filters?.clientId) where.clientId = filters.clientId;
    if (filters?.status) where.status = filters.status as any;
    if (filters?.billingMonth) where.billingMonth = filters.billingMonth;

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        client: { select: { id: true, name: true } },
        responsible: { select: { id: true, name: true } },
        invoices: {
          where: { status: 'PAID' },
          select: { total: true },
        },
        budgetItems: {
          select: {
            id: true,
            description: true,
            hours: true,
            hourlyRate: true,
            amount: true,
            order: true,
          },
          orderBy: { order: 'asc' },
        },
        _count: { select: { tasks: true } },
        tasks: {
          select: {
            id: true,
            title: true,
            status: true,
            assignments: {
              select: { user: { select: { id: true, name: true } } },
              take: 1,
            },
          },
          take: 20,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = projects.map((p) => {
      const invoiced = p.invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
      const budgetTotal = p.budgetItems.reduce((sum, bi) => sum + Number(bi.amount), 0);

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        billingMonth: p.billingMonth,
        client: p.client,
        responsible: p.responsible,
        budget: Number(p.budget ?? 0),
        investment: Number(p.investment ?? 0),
        invoiced,
        budgetTotal,
        budgetItems: p.budgetItems.map((bi) => ({
          id: bi.id,
          description: bi.description,
          hours: Number(bi.hours),
          hourlyRate: Number(bi.hourlyRate),
          amount: Number(bi.amount),
          order: bi.order,
        })),
        tasks: p.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignments[0]?.user || null,
        })),
        taskCount: p._count.tasks,
      };
    });

    const totals = {
      budget: data.reduce((s, d) => s + d.budget, 0),
      investment: data.reduce((s, d) => s + d.investment, 0),
      invoiced: data.reduce((s, d) => s + d.invoiced, 0),
    };

    return { data, totals };
  }
}
