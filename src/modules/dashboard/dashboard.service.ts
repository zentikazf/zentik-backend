import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DashboardFilterDto } from './dto';
import { Prisma } from '@prisma/client';
import { TicketService } from '../ticket/ticket.service';
import {
  calculateSlaOvershoot,
  classifySlaOutcome,
  SlaOutcome,
  TicketSlaShape,
} from '../ticket/sla.util';

type TicketStatusActive = 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'RESOLVED';
type TicketCategoryActive = 'SUPPORT_REQUEST' | 'NEW_DEVELOPMENT';

const ACTIVE_STATUSES: TicketStatusActive[] = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'RESOLVED'];
const ACTIVE_CATEGORIES: TicketCategoryActive[] = ['SUPPORT_REQUEST', 'NEW_DEVELOPMENT'];

export interface StatusBucket {
  count: number;
  complied: number;
  breachedResponse: number;
  breachedResolution: number;
  breachedBoth: number;
  noSla: number;
  avgOvershootMin: number | null;
}

export interface CategorySlaSummary {
  complied: number;
  breachedResponse: number;
  breachedResolution: number;
  avgOvershootMin: number | null;
  compliancePct: number | null;
  noSlaCount: number;
}

export interface CategoryBlock {
  total: number;
  byStatus: Record<TicketStatusActive, StatusBucket>;
  sla: CategorySlaSummary;
}

export interface TicketsBreakdownResponse {
  total: number;
  byCategory: Record<TicketCategoryActive, CategoryBlock>;
  period: { startDate: Date | null; endDate: Date | null };
}

function emptyStatusBucket(): StatusBucket {
  return {
    count: 0,
    complied: 0,
    breachedResponse: 0,
    breachedResolution: 0,
    breachedBoth: 0,
    noSla: 0,
    avgOvershootMin: null,
  };
}

function emptyCategoryBlock(): CategoryBlock {
  return {
    total: 0,
    byStatus: {
      OPEN: emptyStatusBucket(),
      IN_PROGRESS: emptyStatusBucket(),
      IN_REVIEW: emptyStatusBucket(),
      RESOLVED: emptyStatusBucket(),
    },
    sla: {
      complied: 0,
      breachedResponse: 0,
      breachedResolution: 0,
      avgOvershootMin: null,
      compliancePct: null,
      noSlaCount: 0,
    },
  };
}

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
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketService: TicketService,
  ) {}

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
      openTickets,
    ] = await Promise.all([
      this.getActiveProjects(orgId, clientId, memberId),
      this.getPendingTasks(orgId, dateRange, clientId, memberId),
      this.getCompletedTasks(orgId, dateRange, clientId, memberId),
      this.getTeamMembers(orgId, dateRange, monthRange, clientId, memberId),
      this.getHours(orgId, dateRange, clientId, memberId),
      this.getOverdueTasks(orgId, clientId, memberId),
      this.ticketService.getOpenTicketsCount(orgId),
    ]);

    return {
      activeProjects,
      pendingTasks,
      completedTasks,
      teamMembers,
      hours,
      overdueTasks,
      openTickets,
      period: {
        startDate: dateRange.start ?? null,
        endDate: dateRange.end ?? null,
      },
      complianceMonth: { start: monthRange.start, end: monthRange.end },
    };
  }

  private buildDateRange(startDate?: string, endDate?: string) {
    // Sin defaults: si el usuario no envia fechas, devolvemos undefined y los
    // queries no aplican filtro de rango. Default = historico completo.
    return {
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    };
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
    _dateRange: { start?: Date; end?: Date },
    clientId?: string,
    memberId?: string,
  ) {
    // Fase B: "pendiente" es snapshot del estado actual, no foto del rango.
    // Una tarea TODO desde hace meses sigue pendiente aunque no se haya tocado.
    const where: Prisma.TaskWhereInput = {
      project: {
        organizationId: orgId,
        lifecycleStatus: 'ACTIVE',
        ...(clientId && { clientId }),
      },
      status: { in: ['TODO', 'IN_PROGRESS', 'IN_REVIEW'] },
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
    dateRange: { start?: Date; end?: Date },
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
      ...((dateRange.start || dateRange.end) && {
        updatedAt: {
          ...(dateRange.start && { gte: dateRange.start }),
          ...(dateRange.end && { lte: dateRange.end }),
        },
      }),
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
    dateRange: { start?: Date; end?: Date },
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
      // Contrato consistente con el return de exito (linea ~296): incluir
      // thresholds para que el frontend no reciba shape distinto y pueda
      // renderizar empty state sin romper.
      return {
        count: 0,
        items: [],
        thresholds: {
          green: HOURS_COMPLIANCE_GREEN_MIN,
          orange: HOURS_COMPLIANCE_ORANGE_MIN,
        },
      };
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
            ...((dateRange.start || dateRange.end) && {
              updatedAt: {
                ...(dateRange.start && { gte: dateRange.start }),
                ...(dateRange.end && { lte: dateRange.end }),
              },
            }),
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

    // Fase B: TimeEntry.duration esta en SEGUNDOS (estandarizado).
    const activeMap = new Map(activeTaskCounts.map((r) => [r.userId, r._count]));
    const completedMap = new Map(completedTaskCounts.map((r) => [r.userId, r._count]));
    const secondsMap = new Map(
      monthlyMinutes.map((r) => [r.userId, r._sum.duration || 0]),
    );

    const memberStats = members.map((m) => {
      const seconds = secondsMap.get(m.user.id) || 0;
      const hours = Math.round((seconds / 3600) * 100) / 100;
      const minutes = Math.round(seconds / 60);
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
    dateRange: { start?: Date; end?: Date },
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
        ...((dateRange.start || dateRange.end) && {
          startTime: {
            ...(dateRange.start && { gte: dateRange.start }),
            ...(dateRange.end && { lte: dateRange.end }),
          },
        }),
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

    // Fase B: TimeEntry.duration esta en SEGUNDOS (estandarizado).
    let totalSeconds = 0;
    let billableSeconds = 0;
    const byClient = new Map<string, { clientId: string; clientName: string; totalSeconds: number; projectCount: Set<string> }>();

    for (const entry of timeEntries) {
      const secs = entry.duration || 0;
      totalSeconds += secs;
      if (entry.billable) billableSeconds += secs;

      const clientKey = entry.task.project.client?.id || '__no_client__';
      const clientName = entry.task.project.client?.name || 'Sin cliente';

      if (!byClient.has(clientKey)) {
        byClient.set(clientKey, {
          clientId: clientKey,
          clientName,
          totalSeconds: 0,
          projectCount: new Set(),
        });
      }
      const c = byClient.get(clientKey)!;
      c.totalSeconds += secs;
      c.projectCount.add(entry.task.project.id);
    }

    return {
      totalMinutes: Math.round(totalSeconds / 60),
      totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
      billableMinutes: Math.round(billableSeconds / 60),
      billableHours: Math.round((billableSeconds / 3600) * 100) / 100,
      byClient: Array.from(byClient.values()).map((c) => ({
        clientId: c.clientId,
        clientName: c.clientName,
        totalMinutes: Math.round(c.totalSeconds / 60),
        totalHours: Math.round((c.totalSeconds / 3600) * 100) / 100,
        projectCount: c.projectCount.size,
      })),
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Feature #9 — Tickets breakdown (drill-down dashboard)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Devuelve un breakdown de tickets por categoria y estado con metricas SLA
   * agregadas (complied/breach response/breach resolution/no_sla y overshoot
   * promedio en minutos).
   *
   * Filtros aplicados:
   * - organizationId obligatorio.
   * - category ∈ {SUPPORT_REQUEST, NEW_DEVELOPMENT}, status ∈ activos.
   * - rango createdAt (opcional).
   * - clientId (opcional).
   * - memberId: filtra tickets cuya task tenga assignment al miembro. Tickets
   *   sin task asociada NO matchean para ese filtro (decision documentada).
   */
  async getTicketsBreakdown(
    orgId: string,
    filters: DashboardFilterDto,
  ): Promise<TicketsBreakdownResponse> {
    const { startDate, endDate, clientId, memberId } = filters;
    const dateRange = this.buildDateRange(startDate, endDate);

    const where: Prisma.TicketWhereInput = {
      organizationId: orgId,
      category: { in: ACTIVE_CATEGORIES as TicketCategoryActive[] },
      status: { in: ACTIVE_STATUSES as TicketStatusActive[] },
      ...(clientId && { clientId }),
      ...(memberId && {
        task: { assignments: { some: { userId: memberId } } },
      }),
      ...((dateRange.start || dateRange.end) && {
        createdAt: {
          ...(dateRange.start && { gte: dateRange.start }),
          ...(dateRange.end && { lte: dateRange.end }),
        },
      }),
    };

    // Query 1: counts por (category, status) — para baseline rapido y validar
    // invariantes con la iteracion detallada.
    const countsByCategoryStatus = await this.prisma.ticket.groupBy({
      by: ['category', 'status'],
      where,
      _count: { _all: true },
    });

    // Query 2: detalle SLA por ticket — solo campos necesarios (select minimal)
    // para clasificar outcome y calcular overshoot en memoria.
    const ticketsDetail = await this.prisma.ticket.findMany({
      where,
      select: {
        id: true,
        category: true,
        status: true,
        responseDeadline: true,
        resolutionDeadline: true,
        firstResponseAt: true,
        resolvedAt: true,
        slaResponseBreached: true,
        slaResolutionBreached: true,
      },
    });

    // Inicializar estructura del response con ambas categorias activas y los
    // 4 buckets de status — el frontend siempre recibe shape completo.
    const byCategory: Record<TicketCategoryActive, CategoryBlock> = {
      SUPPORT_REQUEST: emptyCategoryBlock(),
      NEW_DEVELOPMENT: emptyCategoryBlock(),
    };

    // Acumuladores de overshoot por (category, status) y por category total.
    const overshootByBucket: Record<TicketCategoryActive, Record<TicketStatusActive, number[]>> = {
      SUPPORT_REQUEST: { OPEN: [], IN_PROGRESS: [], IN_REVIEW: [], RESOLVED: [] },
      NEW_DEVELOPMENT: { OPEN: [], IN_PROGRESS: [], IN_REVIEW: [], RESOLVED: [] },
    };
    const overshootByCategory: Record<TicketCategoryActive, number[]> = {
      SUPPORT_REQUEST: [],
      NEW_DEVELOPMENT: [],
    };

    // Iterar tickets clasificando outcome y computando overshoot.
    for (const t of ticketsDetail) {
      const category = t.category as TicketCategoryActive;
      const status = t.status as TicketStatusActive;
      if (!byCategory[category] || !byCategory[category].byStatus[status]) {
        // Defensa: si Prisma devolviera valor fuera del set esperado, lo saltamos.
        continue;
      }

      const bucket = byCategory[category].byStatus[status];
      bucket.count += 1;
      byCategory[category].total += 1;

      const slaShape: TicketSlaShape = {
        status: t.status,
        responseDeadline: t.responseDeadline,
        resolutionDeadline: t.resolutionDeadline,
        firstResponseAt: t.firstResponseAt,
        resolvedAt: t.resolvedAt,
        slaResponseBreached: t.slaResponseBreached,
        slaResolutionBreached: t.slaResolutionBreached,
      };
      const outcome: SlaOutcome = classifySlaOutcome(slaShape);

      switch (outcome) {
        case 'COMPLIED':
          bucket.complied += 1;
          byCategory[category].sla.complied += 1;
          break;
        case 'BREACHED_RESPONSE':
          bucket.breachedResponse += 1;
          byCategory[category].sla.breachedResponse += 1;
          break;
        case 'BREACHED_RESOLUTION':
          bucket.breachedResolution += 1;
          byCategory[category].sla.breachedResolution += 1;
          break;
        case 'BREACHED_BOTH':
          bucket.breachedResponse += 1;
          bucket.breachedResolution += 1;
          bucket.breachedBoth += 1;
          byCategory[category].sla.breachedResponse += 1;
          byCategory[category].sla.breachedResolution += 1;
          break;
        case 'NO_SLA':
          bucket.noSla += 1;
          byCategory[category].sla.noSlaCount += 1;
          break;
        case 'IN_FLIGHT':
          // No suma a ningun outcome SLA terminal — todavia esta en curso.
          break;
      }

      // Overshoot: positivo solo si llego tarde a resolutionDeadline.
      const overshoot = calculateSlaOvershoot(t.resolutionDeadline, t.resolvedAt);
      if (overshoot !== null && overshoot > 0) {
        overshootByBucket[category][status].push(overshoot);
        overshootByCategory[category].push(overshoot);
      }
    }

    // Computar avgOvershootMin por bucket (null si no hay datos).
    for (const category of ACTIVE_CATEGORIES) {
      for (const status of ACTIVE_STATUSES) {
        const arr = overshootByBucket[category][status];
        if (arr.length > 0) {
          const sum = arr.reduce((acc, v) => acc + v, 0);
          byCategory[category].byStatus[status].avgOvershootMin = Math.round(sum / arr.length);
        }
      }
      const catArr = overshootByCategory[category];
      if (catArr.length > 0) {
        const sum = catArr.reduce((acc, v) => acc + v, 0);
        byCategory[category].sla.avgOvershootMin = Math.round(sum / catArr.length);
      }
      // compliancePct: null si total === 0 (evita 0% misleading).
      const total = byCategory[category].total;
      if (total > 0) {
        const denom = total - byCategory[category].sla.noSlaCount;
        if (denom > 0) {
          byCategory[category].sla.compliancePct = Math.round(
            (byCategory[category].sla.complied / denom) * 100,
          );
        } else {
          byCategory[category].sla.compliancePct = null;
        }
      }
    }

    // Invariante numerica: countsByCategoryStatus debe coincidir con iteracion.
    for (const row of countsByCategoryStatus) {
      const cat = row.category as TicketCategoryActive;
      const st = row.status as TicketStatusActive;
      if (!byCategory[cat] || !byCategory[cat].byStatus[st]) continue;
      const expected = row._count._all;
      const observed = byCategory[cat].byStatus[st].count;
      if (expected !== observed) {
        this.logger.warn(
          `Tickets breakdown invariant mismatch for (${cat}, ${st}): groupBy=${expected} iter=${observed}`,
        );
      }
    }

    const total =
      byCategory.SUPPORT_REQUEST.total + byCategory.NEW_DEVELOPMENT.total;

    return {
      total,
      byCategory,
      period: {
        startDate: dateRange.start ?? null,
        endDate: dateRange.end ?? null,
      },
    };
  }
}
