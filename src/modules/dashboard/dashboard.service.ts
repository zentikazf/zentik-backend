import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DashboardFilterDto } from './dto';
import { Prisma } from '@prisma/client';

// Umbrales absolutos mensuales de cumplimiento de horas por miembro.
// Verde: >= 120h | Naranja: [100, 120) h | Rojo: < 100h
// (el tramo [100, 103) también entra en naranja, tal como lo pidió el usuario).
const HOURS_COMPLIANCE_GREEN_MIN = 120;
const HOURS_COMPLIANCE_ORANGE_MIN = 100;

type ComplianceStatus = 'GREEN' | 'ORANGE' | 'RED';

const getComplianceStatus = (totalHours: number): ComplianceStatus => {
  if (totalHours >= HOURS_COMPLIANCE_GREEN_MIN) return 'GREEN';
  if (totalHours >= HOURS_COMPLIANCE_ORANGE_MIN) return 'ORANGE';
  return 'RED';
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getManagerialDashboard(orgId: string, filters: DashboardFilterDto) {
    const { startDate, endDate, clientId, memberId } = filters;

    const dateRange = this.buildDateRange(startDate, endDate);
    const monthRange = this.buildCurrentMonthRange();

    const [
      activeProjects,
      pendingTasks,
      completedTasks,
      teamMembers,
      hours,
      overdueTasks,
    ] = await Promise.all([
      this.getActiveProjects(orgId, clientId, memberId),
      this.getPendingTasks(orgId, dateRange, clientId, memberId),
      this.getCompletedTasks(orgId, dateRange, clientId, memberId),
      this.getTeamMembers(orgId, dateRange, monthRange, clientId, memberId),
      this.getHours(orgId, dateRange, clientId, memberId),
      this.getOverdueTasks(orgId, clientId, memberId),
    ]);

    return {
      activeProjects,
      pendingTasks,
      completedTasks,
      teamMembers,
      hours,
      overdueTasks,
      period: { startDate: dateRange.start, endDate: dateRange.end },
      complianceMonth: { start: monthRange.start, end: monthRange.end },
    };
  }

  private buildDateRange(startDate?: string, endDate?: string) {
    const now = new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate ? new Date(endDate) : now;
    return { start, end };
  }

  private buildCurrentMonthRange() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end };
  }

  private async getActiveProjects(orgId: string, clientId?: string, memberId?: string) {
    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      lifecycleStatus: 'ACTIVE',
    };
    if (clientId) where.clientId = clientId;
    if (memberId) where.members = { some: { userId: memberId } };

    const projects = await this.prisma.project.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        client: { select: { id: true, name: true } },
        _count: { select: { tasks: true, members: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      count: projects.length,
      items: projects,
    };
  }

  private async getPendingTasks(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    // Filtramos por updatedAt: tareas que siguen pendientes y que tuvieron
    // movimiento dentro del rango (más útil que createdAt, que ocultaba las
    // tareas antiguas que siguen activas).
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
      updatedAt: { gte: dateRange.start, lte: dateRange.end },
    };
    if (memberId) where.assignments = { some: { userId: memberId } };

    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, name: true, slug: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 100,
    });

    return { count: tasks.length, items: tasks };
  }

  private async getCompletedTasks(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: 'DONE',
      updatedAt: { gte: dateRange.start, lte: dateRange.end },
    };
    if (memberId) where.assignments = { some: { userId: memberId } };

    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        priority: true,
        updatedAt: true,
        project: { select: { id: true, name: true, slug: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return { count: tasks.length, items: tasks };
  }

  private async getTeamMembers(
    orgId: string,
    dateRange: { start: Date; end: Date },
    monthRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const projectFilter: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      lifecycleStatus: 'ACTIVE',
      ...(clientId && { clientId }),
    };

    // Traemos miembros excluyendo el rol "Cliente" (externos con acceso al portal).
    const members = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        role: { name: { not: 'Cliente' } },
        ...(memberId && { userId: memberId }),
      },
      select: {
        user: { select: { id: true, name: true, email: true, image: true } },
        role: { select: { id: true, name: true } },
      },
    });

    const memberIds = members.map((m) => m.user.id);
    if (memberIds.length === 0) {
      return { count: 0, items: [] };
    }

    // Tareas activas por usuario (filtradas por cliente si aplica).
    const [activeTaskCounts, completedTaskCounts, monthlyMinutes] = await Promise.all([
      this.prisma.taskAssignment.groupBy({
        by: ['userId'],
        where: {
          userId: { in: memberIds },
          task: {
            project: projectFilter,
            status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
          },
        },
        _count: true,
      }),
      this.prisma.taskAssignment.groupBy({
        by: ['userId'],
        where: {
          userId: { in: memberIds },
          task: {
            project: projectFilter,
            status: 'DONE',
            updatedAt: { gte: dateRange.start, lte: dateRange.end },
          },
        },
        _count: true,
      }),
      // Minutos del mes natural corriente por miembro (independiente de filtros
      // de rango de fechas: la barra de cumplimiento siempre refiere al mes).
      this.prisma.timeEntry.groupBy({
        by: ['userId'],
        where: {
          userId: { in: memberIds },
          startTime: { gte: monthRange.start, lte: monthRange.end },
          task: { project: { organizationId: orgId } },
        },
        _sum: { duration: true },
      }),
    ]);

    const activeMap = new Map(activeTaskCounts.map((r) => [r.userId, r._count]));
    const completedMap = new Map(completedTaskCounts.map((r) => [r.userId, r._count]));
    const minutesMap = new Map(
      monthlyMinutes.map((r) => [r.userId, r._sum.duration || 0]),
    );

    const memberStats = members.map((m) => {
      const minutes = minutesMap.get(m.user.id) || 0;
      const hours = Math.round((minutes / 60) * 100) / 100;
      return {
        ...m.user,
        role: m.role?.name || null,
        activeTasks: activeMap.get(m.user.id) || 0,
        completedTasks: completedMap.get(m.user.id) || 0,
        monthlyMinutes: minutes,
        monthlyHours: hours,
        complianceStatus: getComplianceStatus(hours),
      };
    });

    // Orden: primero los que están en rojo para priorizar atención, luego
    // naranja, luego verde. Dentro de cada grupo, por horas ascendentes.
    const statusWeight: Record<ComplianceStatus, number> = { RED: 0, ORANGE: 1, GREEN: 2 };
    memberStats.sort((a, b) => {
      const sw = statusWeight[a.complianceStatus] - statusWeight[b.complianceStatus];
      if (sw !== 0) return sw;
      return a.monthlyHours - b.monthlyHours;
    });

    return {
      count: memberStats.length,
      items: memberStats,
      thresholds: {
        green: HOURS_COMPLIANCE_GREEN_MIN,
        orange: HOURS_COMPLIANCE_ORANGE_MIN,
      },
    };
  }

  private async getOverdueTasks(
    orgId: string,
    clientId?: string,
    memberId?: string,
  ) {
    // dueDate es un target no bloqueante: exponemos como métrica las tareas
    // con fecha límite vencida que todavía no están cerradas.
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: { notIn: ['DONE', 'CANCELLED'] },
      dueDate: { lt: new Date() },
    };
    if (memberId) where.assignments = { some: { userId: memberId } };

    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, name: true, slug: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
          take: 3,
        },
      },
      orderBy: { dueDate: 'asc' },
      take: 100,
    });

    return { count: tasks.length, items: tasks };
  }

  private async getHours(
    orgId: string,
    dateRange: { start: Date; end: Date },
    clientId?: string,
    memberId?: string,
  ) {
    const taskFilter: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
    };
    if (memberId) taskFilter.assignments = { some: { userId: memberId } };

    const timeEntries = await this.prisma.timeEntry.findMany({
      where: {
        task: taskFilter,
        startTime: { gte: dateRange.start, lte: dateRange.end },
      },
      include: {
        task: {
          select: {
            project: {
              select: {
                id: true,
                name: true,
                client: { select: { id: true, name: true } },
                estimatedHours: true,
              },
            },
          },
        },
      },
    });

    let totalMinutes = 0;
    let billableMinutes = 0;
    const byClient = new Map<string, { clientId: string; clientName: string; totalMinutes: number; projectCount: Set<string> }>();

    for (const entry of timeEntries) {
      const mins = entry.duration || 0;
      totalMinutes += mins;
      if (entry.billable) billableMinutes += mins;

      const clientKey = entry.task.project.client?.id || '__no_client__';
      const clientName = entry.task.project.client?.name || 'Sin cliente';

      if (!byClient.has(clientKey)) {
        byClient.set(clientKey, {
          clientId: clientKey,
          clientName,
          totalMinutes: 0,
          projectCount: new Set(),
        });
      }
      const c = byClient.get(clientKey)!;
      c.totalMinutes += mins;
      c.projectCount.add(entry.task.project.id);
    }

    return {
      totalMinutes,
      totalHours: Math.round((totalMinutes / 60) * 100) / 100,
      billableMinutes,
      billableHours: Math.round((billableMinutes / 60) * 100) / 100,
      byClient: Array.from(byClient.values()).map((c) => ({
        clientId: c.clientId,
        clientName: c.clientName,
        totalMinutes: c.totalMinutes,
        totalHours: Math.round((c.totalMinutes / 60) * 100) / 100,
        projectCount: c.projectCount.size,
      })),
    };
  }
}
