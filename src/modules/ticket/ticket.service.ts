import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Prisma,
  TicketStatus,
  TaskStatus,
  TicketCloseReason,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
import { CreateCategoryConfigDto, UpdateCategoryConfigDto } from './dto/create-category-config.dto';
import { UpsertSlaConfigDto } from './dto/upsert-sla-config.dto';
import { UpsertBusinessHoursDto } from './dto/upsert-business-hours.dto';
import { domainEvent } from '../../common/events/domain-event.helper';
import { calculateBusinessDeadline, parseBusinessDays } from './sla.util';
import { TicketEventsService } from './ticket-events.service';

/**
 * Generates a sequential ticket number per org: YYYYMMDD-NNN
 */
export async function generateTicketNumber(
  tx: {
    ticket: {
      count: (args: any) => Promise<number>;
      findFirst: (args: any) => Promise<any>;
    };
  },
  organizationId: string,
): Promise<string> {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  const countToday = await tx.ticket.count({
    where: {
      organizationId,
      createdAt: { gte: startOfDay, lt: endOfDay },
    },
  });

  for (let offset = 0; offset < 10; offset++) {
    const candidate = `${dateStr}-${String(countToday + 1 + offset).padStart(3, '0')}`;
    const exists = await tx.ticket.findFirst({
      where: { organizationId, ticketNumber: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }

  throw new Error(
    `No se pudo generar un numero de ticket unico para la organizacion ${organizationId}`,
  );
}

// ─── State machine: transiciones válidas del ticket ────────────────────
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN:        ['IN_PROGRESS', 'IN_REVIEW', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['IN_REVIEW', 'RESOLVED', 'OPEN', 'CLOSED'],
  IN_REVIEW:   ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED:    ['CLOSED', 'IN_PROGRESS'],
  CLOSED:      ['IN_PROGRESS'],
};

// ─── Mapping: estado del ticket → estado del task en kanban ────────────
function mapTicketStatusToTaskStatus(
  ticketStatus: TicketStatus,
  hasAssignee: boolean,
): TaskStatus {
  switch (ticketStatus) {
    case 'OPEN':
      return hasAssignee ? 'TODO' : 'BACKLOG';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'IN_REVIEW':
      return 'IN_REVIEW';
    case 'RESOLVED':
      return 'DONE';
    case 'CLOSED':
      return 'DONE';
  }
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly events: TicketEventsService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private validateStatusTransition(from: TicketStatus, to: TicketStatus) {
    if (from === to) return;
    const allowed = ALLOWED_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new AppException(
        `Transicion invalida: ${from} → ${to}`,
        'INVALID_STATUS_TRANSITION',
        400,
        { from, to, allowed },
      );
    }
  }

  /**
   * Move task to the column matching the given mapped status (within same project).
   * No-op if task already on a column with that mappedStatus.
   * Also updates task.status and emits 'task.moved' with a sync flag to prevent loops.
   */
  private async syncTaskToStatus(
    tx: Prisma.TransactionClient,
    taskId: string,
    targetStatus: TaskStatus,
    userId: string,
    organizationId: string,
  ) {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        status: true,
        projectId: true,
        boardColumnId: true,
        startDate: true,
        endDate: true,
        title: true,
        type: true,
        estimatedHours: true,
        createdAt: true,
      },
    });
    if (!task) return null;

    if (task.status === targetStatus) return task;

    const targetColumn = await tx.boardColumn.findFirst({
      where: {
        mappedStatus: targetStatus,
        board: { projectId: task.projectId },
      },
      orderBy: { position: 'asc' },
    });

    const updateData: Prisma.TaskUpdateInput = { status: targetStatus };
    if (targetColumn) {
      updateData.boardColumn = { connect: { id: targetColumn.id } };
    }
    if (targetStatus === 'IN_PROGRESS' && !task.startDate) {
      updateData.startDate = new Date();
    }
    if (targetStatus === 'DONE' && !task.endDate) {
      updateData.endDate = new Date();
    }

    const updated = await tx.task.update({
      where: { id: task.id },
      data: updateData,
    });

    // Emit task.moved INSIDE the transaction-aware code path but AFTER tx commits
    // (we attach to the queue to be flushed by the caller)
    this.pendingEvents.push(() => {
      this.eventEmitter.emit('task.moved', {
        ...domainEvent('task.moved', 'task', task.id, organizationId, userId),
        task: updated,
        previousColumnId: task.boardColumnId,
        targetColumnId: targetColumn?.id ?? task.boardColumnId,
        previousStatus: task.status,
        newStatus: targetStatus,
        userId,
        // Loop guard: this move was triggered by the ticket sync, not by the user
        metadata: { fromTicketSync: true },
      });

      // Hours deduction / reverse for SUPPORT tasks
      if (targetStatus === 'DONE' && task.status !== 'DONE') {
        this.eventEmitter.emit('task.completed', {
          ...domainEvent('task.completed', 'task', task.id, organizationId, userId, { title: task.title, projectId: task.projectId }),
          task: { ...updated, type: task.type, projectId: task.projectId, createdAt: task.createdAt, estimatedHours: task.estimatedHours },
        });
      }
      if (task.status === 'DONE' && targetStatus !== 'DONE') {
        this.eventEmitter.emit('task.reopened', {
          ...domainEvent('task.reopened', 'task', task.id, organizationId, userId, { title: task.title, projectId: task.projectId }),
          task: { ...updated, type: task.type, projectId: task.projectId },
        });
      }
    });

    return updated;
  }

  // Per-call queue to flush events after a transaction commits.
  // (instance-level OK because methods are awaited end-to-end)
  private pendingEvents: Array<() => void> = [];
  private flushPendingEvents() {
    const queue = this.pendingEvents;
    this.pendingEvents = [];
    for (const emit of queue) {
      try {
        emit();
      } catch (err) {
        this.logger.error('Error flushing pending event', err as Error);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Listing / Stats
  // ────────────────────────────────────────────────────────────

  async getOpenTicketsCount(orgId: string) {
    const count = await this.prisma.ticket.count({
      where: { organizationId: orgId, status: 'OPEN' },
    });
    return { count };
  }

  async getTicketStats(orgId: string) {
    const grouped = await this.prisma.ticket.groupBy({
      by: ['status'],
      where: { organizationId: orgId },
      _count: { _all: true },
    });

    const base: Record<TicketStatus | 'TOTAL', number> = {
      OPEN: 0,
      IN_PROGRESS: 0,
      IN_REVIEW: 0,
      RESOLVED: 0,
      CLOSED: 0,
      TOTAL: 0,
    };

    for (const row of grouped) {
      base[row.status] = row._count._all;
      base.TOTAL += row._count._all;
    }

    return base;
  }

  async getOrgTickets(orgId: string, query: ListTicketsQueryDto) {
    const limit = Math.min(query.limit ?? 20, 50);

    const where: Prisma.TicketWhereInput = {
      organizationId: orgId,
      ...(query.status && { status: query.status as TicketStatus }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.createdByUserId && { createdByUserId: query.createdByUserId }),
      ...(query.categoryConfigId && { categoryConfigId: query.categoryConfigId }),
      ...(query.assigneeId && {
        task: { assignments: { some: { userId: query.assigneeId } } },
      }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' as const } },
          { id: { contains: query.search, mode: 'insensitive' as const } },
          { ticketNumber: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const items = await this.prisma.ticket.findMany({
      where,
      take: limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
            assignments: {
              include: { user: { select: { id: true, name: true, email: true, image: true } } },
            },
          },
        },
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
        categoryConfig: { select: { id: true, name: true, criticality: true } },
        createdByUser: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, limit) : items;
    const nextCursor = hasNext ? data[data.length - 1].id : null;

    return {
      data,
      meta: { nextCursor, limit, hasNext },
    };
  }

  async getProjectTickets(projectId: string) {
    return this.prisma.ticket.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
            assignments: {
              include: { user: { select: { id: true, name: true, image: true } } },
            },
          },
        },
        channel: { select: { id: true, name: true, _count: { select: { messages: true } } } },
        categoryConfig: { select: { id: true, name: true, criticality: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTicketDetail(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        project: { select: { id: true, name: true, slug: true } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            boardColumn: { select: { id: true, name: true, color: true, mappedStatus: true } },
            assignments: {
              include: { user: { select: { id: true, name: true, email: true, image: true } } },
            },
          },
        },
        channel: {
          select: { id: true, name: true, _count: { select: { messages: true } } },
        },
        categoryConfig: { select: { id: true, name: true, criticality: true } },
        createdByUser: { select: { id: true, name: true } },
        closedByUser: { select: { id: true, name: true } },
      },
    });

    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    return ticket;
  }

  async getTicketEvents(ticketId: string) {
    const exists = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (!exists) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }
    return this.events.listByTicket(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Update (status + asignación + sync con kanban)
  // ────────────────────────────────────────────────────────────

  async updateTicket(ticketId: string, dto: UpdateTicketDto, userId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        task: {
          select: {
            id: true,
            status: true,
            projectId: true,
            assignments: { select: { userId: true } },
          },
        },
      },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    const wantsStatus = dto.status !== undefined && dto.status !== ticket.status;
    const wantsAssignee = dto.assigneeId !== undefined;
    const wantsNotes = dto.adminNotes !== undefined;

    if (wantsStatus) {
      this.validateStatusTransition(ticket.status, dto.status as TicketStatus);
    }

    // Cannot transition to CLOSED via PATCH — must use the dedicated /close endpoint
    if (wantsStatus && dto.status === 'CLOSED') {
      throw new AppException(
        'Para cerrar un ticket usa el endpoint POST /tickets/:id/close con motivo',
        'CLOSE_ENDPOINT_REQUIRED',
        400,
      );
    }

    const previousAssigneeId = ticket.task?.assignments[0]?.userId ?? null;
    const previousStatus = ticket.status;
    const newStatus = (dto.status as TicketStatus) ?? ticket.status;

    // Determine the effective assigneeId AFTER this update for kanban mapping
    let effectiveAssigneeId: string | null = previousAssigneeId;
    if (wantsAssignee) {
      effectiveAssigneeId = dto.assigneeId ?? null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1) Update ticket fields
      const data: Prisma.TicketUpdateInput = {};
      if (wantsStatus) {
        data.status = newStatus;
        // SLA auto-marks
        if (newStatus === 'IN_PROGRESS' && !ticket.firstResponseAt) {
          data.firstResponseAt = new Date();
        }
        if (newStatus === 'RESOLVED' && !ticket.resolvedAt) {
          data.resolvedAt = new Date();
        }
      }
      if (wantsNotes) {
        data.adminNotes = dto.adminNotes ?? null;
      }

      const result = Object.keys(data).length > 0
        ? await tx.ticket.update({
            where: { id: ticketId },
            data,
            include: {
              client: { select: { id: true, name: true } },
              project: { select: { id: true, name: true } },
              task: {
                select: {
                  id: true,
                  status: true,
                  boardColumn: { select: { id: true, name: true, mappedStatus: true } },
                },
              },
            },
          })
        : await tx.ticket.findUniqueOrThrow({
            where: { id: ticketId },
            include: {
              client: { select: { id: true, name: true } },
              project: { select: { id: true, name: true } },
              task: {
                select: {
                  id: true,
                  status: true,
                  boardColumn: { select: { id: true, name: true, mappedStatus: true } },
                },
              },
            },
          });

      // 2) Asignación: replace assignments del task asociado
      if (wantsAssignee && ticket.task) {
        if (dto.assigneeId === null || dto.assigneeId === undefined || dto.assigneeId === '') {
          // Des-asignar todos
          await tx.taskAssignment.deleteMany({ where: { taskId: ticket.task.id } });
        } else {
          // Validar que el usuario pertenezca a la org del ticket
          const member = await tx.organizationMember.findFirst({
            where: {
              organizationId: ticket.organizationId,
              userId: dto.assigneeId,
            },
            select: { id: true },
          });
          if (!member) {
            throw new AppException(
              'El usuario asignado no pertenece a la organizacion',
              'ASSIGNEE_NOT_IN_ORG',
              400,
              { assigneeId: dto.assigneeId },
            );
          }
          // Limpiar y asignar (single-assignee model para ticket — un responsable principal)
          await tx.taskAssignment.deleteMany({ where: { taskId: ticket.task.id } });
          await tx.taskAssignment.create({
            data: { taskId: ticket.task.id, userId: dto.assigneeId },
          });
        }

        await this.events.writeEventTx(tx, {
          ticketId,
          type: dto.assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
          fromValue: previousAssigneeId,
          toValue: dto.assigneeId ?? null,
          source: 'TICKET',
          userId,
        });
      }

      // 3) Audit log de status change
      if (wantsStatus) {
        await this.events.writeEventTx(tx, {
          ticketId,
          type: 'STATUS_CHANGE',
          fromValue: previousStatus,
          toValue: newStatus,
          source: 'TICKET',
          userId,
        });
      }

      // 4) Sync kanban: si hay task asociada, mover según mapping
      if (ticket.task) {
        const targetTaskStatus = mapTicketStatusToTaskStatus(newStatus, !!effectiveAssigneeId);
        await this.syncTaskToStatus(
          tx,
          ticket.task.id,
          targetTaskStatus,
          userId,
          ticket.organizationId,
        );
      }

      return result;
    });

    // ── Emit domain events AFTER transaction commits ─────────
    this.flushPendingEvents();

    if (wantsStatus) {
      this.eventEmitter.emit('ticket.updated', {
        ...domainEvent('ticket.updated', 'ticket', updated.id, ticket.organizationId, userId),
        ticketId: updated.id,
        title: updated.title,
        previousStatus,
        status: newStatus,
        projectId: updated.project?.id,
        clientId: updated.client?.id,
        organizationId: ticket.organizationId,
        // Loop guard for downstream listeners that also handle task.moved
        metadata: { fromTicketUpdate: true },
      });
    }

    if (wantsAssignee && dto.assigneeId !== previousAssigneeId) {
      this.eventEmitter.emit('ticket.assigned', {
        ...domainEvent('ticket.assigned', 'ticket', updated.id, ticket.organizationId, userId),
        ticketId: updated.id,
        taskId: ticket.task?.id,
        previousAssigneeId,
        newAssigneeId: dto.assigneeId ?? null,
        organizationId: ticket.organizationId,
      });
    }

    this.logger.log(
      `Ticket ${ticketId} actualizado por ${userId} — status=${newStatus} assignee=${effectiveAssigneeId ?? '∅'}`,
    );

    return this.getTicketDetail(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Cerrar ticket (endpoint dedicado)
  // ────────────────────────────────────────────────────────────

  async closeTicket(ticketId: string, dto: CloseTicketDto, userId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { task: { select: { id: true, status: true, projectId: true } } },
    });
    if (!ticket) {
      throw new AppException('Ticket no encontrado', 'TICKET_NOT_FOUND', 404);
    }

    if (ticket.status === 'CLOSED') {
      throw new AppException(
        'El ticket ya esta cerrado',
        'ALREADY_CLOSED',
        400,
      );
    }

    this.validateStatusTransition(ticket.status, 'CLOSED');

    const previousStatus = ticket.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'CLOSED',
          closeReason: dto.reason as TicketCloseReason,
          closeNote: dto.note ?? null,
          closedAt: new Date(),
          closedByUserId: userId,
          // SLA auto-marks
          ...(ticket.firstResponseAt === null && { firstResponseAt: new Date() }),
          ...(ticket.resolvedAt === null && { resolvedAt: new Date() }),
        },
      });

      await this.events.writeEventTx(tx, {
        ticketId,
        type: 'CLOSED',
        fromValue: previousStatus,
        toValue: 'CLOSED',
        source: 'TICKET',
        userId,
        metadata: { reason: dto.reason, note: dto.note },
      });

      // Sync task → DONE (a menos que el ticket se cerró sin resolverse,
      // en cuyo caso preservamos el comportamiento legacy: cancelar la task)
      if (ticket.task) {
        const wasNeverResolved = ticket.resolvedAt === null && previousStatus !== 'RESOLVED';
        if (wasNeverResolved) {
          if (ticket.task.status !== 'CANCELLED') {
            await tx.task.update({
              where: { id: ticket.task.id },
              data: { status: 'CANCELLED' },
            });
            this.pendingEvents.push(() => {
              this.eventEmitter.emit('task.updated', {
                taskId: ticket.task!.id,
                status: 'CANCELLED',
                projectId: ticket.task!.projectId,
                reason: 'ticket_closed_unresolved',
                organizationId: ticket.organizationId,
              });
            });
          }
        } else {
          await this.syncTaskToStatus(tx, ticket.task.id, 'DONE', userId, ticket.organizationId);
        }
      }
    });

    this.flushPendingEvents();

    this.eventEmitter.emit('ticket.closed', {
      ...domainEvent('ticket.closed', 'ticket', ticketId, ticket.organizationId, userId),
      ticketId,
      reason: dto.reason,
      previousStatus,
      organizationId: ticket.organizationId,
    });

    this.eventEmitter.emit('ticket.updated', {
      ...domainEvent('ticket.updated', 'ticket', ticketId, ticket.organizationId, userId),
      ticketId,
      previousStatus,
      status: 'CLOSED',
      organizationId: ticket.organizationId,
      metadata: { fromTicketUpdate: true, closed: true },
    });

    this.logger.log(`Ticket ${ticketId} cerrado por ${userId} — motivo=${dto.reason}`);

    return this.getTicketDetail(ticketId);
  }

  // ────────────────────────────────────────────────────────────
  // Sync inverso (llamado por TicketSyncListener desde kanban events)
  // ────────────────────────────────────────────────────────────

  /**
   * Sincronizar el ticket cuando una task asociada cambia de estado en kanban.
   * Loop guard: si el caller marca metadata.fromTicketSync, no re-sincronizar.
   * Devuelve el ticket actualizado o null si la task no está asociada a un ticket.
   */
  async syncTicketFromTaskMove(
    taskId: string,
    newTaskStatus: TaskStatus,
    userId: string,
    options: { skipIfFromTicketSync?: boolean; organizationId?: string } = {},
  ) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { taskId },
      select: {
        id: true,
        status: true,
        organizationId: true,
        firstResponseAt: true,
        resolvedAt: true,
      },
    });
    if (!ticket) return null; // task no es de un ticket → no hacer nada

    // Mapping inverso task → ticket
    let targetTicketStatus: TicketStatus | null = null;
    switch (newTaskStatus) {
      case 'BACKLOG':
      case 'TODO':
        targetTicketStatus = 'OPEN';
        break;
      case 'IN_PROGRESS':
        targetTicketStatus = 'IN_PROGRESS';
        break;
      case 'IN_REVIEW':
        targetTicketStatus = 'IN_REVIEW';
        break;
      case 'DONE':
        // El kanban yendo a DONE solo lleva a RESOLVED, NUNCA a CLOSED
        targetTicketStatus = 'RESOLVED';
        break;
      case 'CANCELLED':
        // No auto-sincronizar cancelaciones — requiere acción explícita
        return null;
    }

    if (!targetTicketStatus || targetTicketStatus === ticket.status) {
      return null;
    }

    // Verificar transición válida; si no es válida, registrar warning y abortar
    const allowed = ALLOWED_TRANSITIONS[ticket.status];
    if (!allowed.includes(targetTicketStatus)) {
      this.logger.warn(
        `Sync ignorado: ${ticket.status} → ${targetTicketStatus} no permitido (taskId=${taskId})`,
      );
      return null;
    }

    const data: Prisma.TicketUpdateInput = { status: targetTicketStatus };
    if (targetTicketStatus === 'IN_PROGRESS' && !ticket.firstResponseAt) {
      data.firstResponseAt = new Date();
    }
    if (targetTicketStatus === 'RESOLVED' && !ticket.resolvedAt) {
      data.resolvedAt = new Date();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.ticket.update({
        where: { id: ticket.id },
        data,
      });
      await this.events.writeEventTx(tx, {
        ticketId: ticket.id,
        type: 'KANBAN_MOVE',
        fromValue: ticket.status,
        toValue: targetTicketStatus,
        source: 'KANBAN',
        userId,
        metadata: { taskId, newTaskStatus },
      });
      return result;
    });

    this.eventEmitter.emit('ticket.updated', {
      ...domainEvent('ticket.updated', 'ticket', ticket.id, ticket.organizationId, userId),
      ticketId: ticket.id,
      previousStatus: ticket.status,
      status: targetTicketStatus,
      organizationId: ticket.organizationId,
      // Loop guard: este update vino de kanban, NO re-sincronizar
      metadata: { fromKanbanSync: true },
    });

    this.logger.log(
      `Ticket ${ticket.id} sync desde kanban: ${ticket.status} → ${targetTicketStatus}`,
    );

    return updated;
  }

  // ────────────────────────────────────────────────────────────
  // Crear ticket (admin)
  // ────────────────────────────────────────────────────────────

  async createTicket(orgId: string, dto: CreateAdminTicketDto, createdByUserId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: dto.clientId, organizationId: orgId },
    });
    if (!client) {
      throw new AppException('Cliente no encontrado', 'CLIENT_NOT_FOUND', 404);
    }

    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, organizationId: orgId, clientId: dto.clientId },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdById: true,
        responsibleId: true,
        members: { select: { userId: true } },
      },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado o no pertenece al cliente', 'PROJECT_NOT_FOUND', 404);
    }

    let categoryConfig: any = null;
    let criticality: string | null = null;
    let responseDeadline: Date | null = null;
    let resolutionDeadline: Date | null = null;

    if (dto.categoryConfigId) {
      categoryConfig = await this.prisma.ticketCategoryConfig.findFirst({
        where: { id: dto.categoryConfigId, organizationId: orgId, isActive: true },
      });
    }

    if (categoryConfig) {
      criticality = categoryConfig.criticality;
      const slaConfig = await this.prisma.slaConfig.findUnique({
        where: { organizationId_criticality: { organizationId: orgId, criticality: categoryConfig.criticality } },
      });

      if (slaConfig) {
        const [businessHours, holidayRows] = await Promise.all([
          this.prisma.businessHoursConfig.findUnique({ where: { organizationId: orgId } }),
          this.prisma.holiday.findMany({ where: { organizationId: orgId }, select: { date: true } }),
        ]);

        const bhConfig = businessHours
          ? { start: businessHours.businessHoursStart, end: businessHours.businessHoursEnd, days: parseBusinessDays(businessHours.businessDays), timezone: businessHours.timezone }
          : undefined;

        const holidays = holidayRows.map((h) => h.date);
        const now = new Date();
        responseDeadline = calculateBusinessDeadline(now, slaConfig.responseTimeMinutes, bhConfig, holidays);
        resolutionDeadline = calculateBusinessDeadline(now, slaConfig.resolutionTimeMinutes, bhConfig, holidays);
      }
    }

    const categoryLabel = dto.category === 'SUPPORT_REQUEST' ? 'Soporte' : 'Desarrollo';
    const channelName = `[${categoryLabel}] ${dto.title}`;
    const taskTitle = `[Ticket] ${dto.title}`;

    const memberIds = project.members.map((m) => m.userId);
    if (client.userId && !memberIds.includes(client.userId)) {
      memberIds.push(client.userId);
    }
    if (project.responsibleId && !memberIds.includes(project.responsibleId)) {
      memberIds.push(project.responsibleId);
    }
    const poAndPm = await this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        role: { name: { in: ['Product Owner', 'Project Manager'] } },
      },
      select: { userId: true },
    });
    for (const member of poAndPm) {
      if (!memberIds.includes(member.userId)) {
        memberIds.push(member.userId);
      }
    }

    const ticket = await this.prisma.$transaction(async (tx) => {
      const maxPosition = await tx.task.aggregate({
        where: { projectId: dto.projectId },
        _max: { position: true },
      });

      const backlogColumn = await tx.boardColumn.findFirst({
        where: {
          mappedStatus: 'BACKLOG',
          board: { projectId: dto.projectId },
        },
        orderBy: { position: 'asc' },
      });

      const task = await tx.task.create({
        data: {
          projectId: dto.projectId,
          title: taskTitle,
          description: dto.description,
          priority: (dto.priority as any) ?? 'MEDIUM',
          status: 'BACKLOG',
          type: 'SUPPORT',
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: createdByUserId,
          clientVisible: true,
          ...(backlogColumn && { boardColumnId: backlogColumn.id }),
        },
      });

      const channel = await tx.channel.create({
        data: {
          name: channelName,
          type: 'TICKET',
          organizationId: orgId,
          createdById: createdByUserId,
          members: {
            create: memberIds.map((id) => ({ userId: id })),
          },
        },
      });

      const ticketNumber = await generateTicketNumber(tx, orgId);

      const created = await tx.ticket.create({
        data: {
          organizationId: orgId,
          projectId: dto.projectId,
          clientId: dto.clientId,
          title: dto.title,
          description: dto.description,
          category: dto.category as any,
          priority: (dto.priority as any) ?? 'MEDIUM',
          taskId: task.id,
          channelId: channel.id,
          createdByUserId,
          ticketNumber,
          ...(categoryConfig && { categoryConfigId: categoryConfig.id }),
          ...(criticality && { criticality: criticality as any }),
          ...(responseDeadline && { responseDeadline }),
          ...(resolutionDeadline && { resolutionDeadline }),
        },
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
          channel: { select: { id: true, name: true } },
          categoryConfig: { select: { id: true, name: true, criticality: true } },
        },
      });

      // Audit: ticket creado
      await this.events.writeEventTx(tx, {
        ticketId: created.id,
        type: 'STATUS_CHANGE',
        fromValue: null,
        toValue: 'OPEN',
        source: 'TICKET',
        userId: createdByUserId,
        metadata: { event: 'created' },
      });

      return created;
    });

    this.logger.log(`Ticket created by admin: ${ticket.id} for client: ${dto.clientId}`);

    this.eventEmitter.emit('ticket.created', {
      ...domainEvent('ticket.created', 'ticket', ticket.id, orgId, createdByUserId),
      ticketId: ticket.id,
      title: dto.title,
      category: dto.category,
      projectId: dto.projectId,
      clientName: client.name,
      organizationId: orgId,
    });

    return ticket;
  }

  // ────────────────────────────────────────────────────────────
  // Categories / SLA / Business Hours / Holidays — sin cambios
  // ────────────────────────────────────────────────────────────

  async getCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getActiveCategories(orgId: string) {
    return this.prisma.ticketCategoryConfig.findMany({
      where: { organizationId: orgId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(orgId: string, dto: CreateCategoryConfigDto) {
    return this.prisma.ticketCategoryConfig.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        description: dto.description,
        criticality: dto.criticality as any,
      },
    });
  }

  async updateCategory(orgId: string, categoryId: string, dto: UpdateCategoryConfigDto) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }

    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.criticality !== undefined && { criticality: dto.criticality as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deleteCategory(orgId: string, categoryId: string) {
    const existing = await this.prisma.ticketCategoryConfig.findFirst({
      where: { id: categoryId, organizationId: orgId },
    });
    if (!existing) {
      throw new AppException('Categoría no encontrada', 'CATEGORY_NOT_FOUND', 404);
    }
    return this.prisma.ticketCategoryConfig.update({
      where: { id: categoryId },
      data: { isActive: false },
    });
  }

  async getSlaConfigs(orgId: string) {
    return this.prisma.slaConfig.findMany({
      where: { organizationId: orgId },
      orderBy: { criticality: 'asc' },
    });
  }

  async upsertSlaConfigs(orgId: string, dto: UpsertSlaConfigDto) {
    return this.prisma.$transaction(
      dto.configs.map((config) =>
        this.prisma.slaConfig.upsert({
          where: { organizationId_criticality: { organizationId: orgId, criticality: config.criticality as any } },
          create: {
            organizationId: orgId,
            criticality: config.criticality as any,
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
          update: {
            responseTimeMinutes: config.responseTimeMinutes,
            resolutionTimeMinutes: config.resolutionTimeMinutes,
          },
        }),
      ),
    );
  }

  async getBusinessHours(orgId: string) {
    const config = await this.prisma.businessHoursConfig.findUnique({
      where: { organizationId: orgId },
    });
    return config || {
      businessHoursStart: '08:30',
      businessHoursEnd: '17:30',
      businessDays: '1,2,3,4,5',
      timezone: 'America/Asuncion',
    };
  }

  async upsertBusinessHours(orgId: string, dto: UpsertBusinessHoursDto) {
    return this.prisma.businessHoursConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        timezone: dto.timezone || 'America/Asuncion',
      },
      update: {
        businessHoursStart: dto.businessHoursStart,
        businessHoursEnd: dto.businessHoursEnd,
        businessDays: dto.businessDays,
        ...(dto.timezone && { timezone: dto.timezone }),
      },
    });
  }

  async getHolidays(orgId: string) {
    return this.prisma.holiday.findMany({
      where: { organizationId: orgId },
      orderBy: { date: 'asc' },
    });
  }

  async createHoliday(orgId: string, dto: { name: string; date: string; recurring?: boolean }) {
    return this.prisma.holiday.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        date: new Date(dto.date),
        recurring: dto.recurring ?? false,
      },
    });
  }

  async deleteHoliday(orgId: string, holidayId: string) {
    const holiday = await this.prisma.holiday.findFirst({
      where: { id: holidayId, organizationId: orgId },
    });
    if (!holiday) {
      throw new AppException('El feriado no existe', 'HOLIDAY_NOT_FOUND', 404);
    }
    await this.prisma.holiday.delete({ where: { id: holidayId } });
  }
}
