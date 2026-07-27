import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { domainEvent } from '../../common/events/domain-event.helper';
import { ProjectService } from '../project/project.service';
import { ClientService } from '../client/client.service';
import {
  TaskHoursGuardService,
  HoursGateActorContext,
} from './task-hours-guard.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  TaskFilterDto,
  TaskTypeDto,
} from './dto';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly projectService: ProjectService,
    private readonly clientService: ClientService,
    private readonly hoursGuard: TaskHoursGuardService,
  ) {}

  /**
   * Validates that the client linked to a project has enough available hours
   * for a SUPPORT task with the given estimatedHours. Throws if insufficient.
   */
  private async assertSupportHoursAvailable(projectId: string, estimatedHours: number | undefined | null, excludeTaskId?: string) {
    if (!estimatedHours || estimatedHours <= 0) return;

    const hoursInfo = await this.clientService.getAvailableHoursByProject(projectId);
    if (!hoursInfo) return; // No client linked — skip validation

    // If updating, add back the hours that were previously estimated for this task (so we don't double-count)
    let adjustedAvailable = hoursInfo.availableHours;
    if (excludeTaskId) {
      const existingTask = await this.prisma.task.findUnique({
        where: { id: excludeTaskId },
        select: { estimatedHours: true, type: true },
      });
      if (existingTask?.type === 'SUPPORT' && existingTask.estimatedHours) {
        adjustedAvailable += existingTask.estimatedHours;
      }
    }

    if (estimatedHours > adjustedAvailable) {
      throw new AppException(
        `Horas insuficientes: el cliente "${hoursInfo.clientName}" tiene ${adjustedAvailable.toFixed(1)}h disponibles, pero la tarea requiere ${estimatedHours}h. Contacta al encargado para gestionar más horas con el cliente.`,
        'INSUFFICIENT_CLIENT_HOURS',
        400,
        {
          availableHours: adjustedAvailable,
          requestedHours: estimatedHours,
          clientId: hoursInfo.clientId,
          clientName: hoursInfo.clientName,
          contractedHours: hoursInfo.contractedHours,
          usedHours: hoursInfo.usedHours,
        },
      );
    }
  }

  async createTask(projectId: string, dto: CreateTaskDto, userId: string, actor?: HoursGateActorContext) {
    await this.projectService.assertProjectNotFrozen(projectId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404, { projectId });
    }

    // Validar disponibilidad de cupo SOLO para tareas SUPPORT (H1 OBJ-1): PROJECT ya no consume
    // cupo, así que no tiene sentido bloquear su creación por falta de horas. Simetría con updateTask
    // (:354, que ya filtra por SUPPORT). Task.type tiene @default(PROJECT): si dto.type es undefined
    // la tarea nace PROJECT y no se valida cupo (los tickets crean SUPPORT explícito).
    if (dto.estimatedHours && dto.type === TaskTypeDto.SUPPORT) {
      await this.assertSupportHoursAvailable(projectId, dto.estimatedHours);
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const maxPosition = await tx.task.aggregate({
        where: { projectId },
        _max: { position: true },
      });

      // Auto-resolver boardColumn si no viene en dto: buscar la columna que mapee al status (BACKLOG → "Nuevo")
      let autoColumnId: string | undefined = dto.boardColumnId;
      if (!autoColumnId) {
        const targetStatus = dto.status ?? 'BACKLOG';
        const matchingColumn = await tx.boardColumn.findFirst({
          where: { board: { projectId }, mappedStatus: targetStatus },
          select: { id: true },
          orderBy: { position: 'asc' },
        });
        autoColumnId = matchingColumn?.id;
      }

      const created = await tx.task.create({
        data: {
          projectId,
          title: dto.title,
          description: dto.description,
          status: dto.status,
          priority: dto.priority,
          type: dto.type,
          storyPoints: dto.storyPoints,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          estimatedHours: dto.estimatedHours,
          // originalEstimate inmutable: se siembra al crear con la primera estimacion
          originalEstimate: dto.estimatedHours,
          hourlyRate: dto.hourlyRate,
          roleId: dto.roleId,
          boardColumnId: autoColumnId,
          sprintId: dto.sprintId,
          ...(dto.clientVisible !== undefined && { clientVisible: dto.clientVisible }),
          ...(dto.billable !== undefined && { billable: dto.billable }),
          position: (maxPosition._max.position ?? -1) + 1,
          createdById: userId,
        },
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: true,
        },
      });

      // Create assignments
      if (dto.assigneeIds?.length) {
        await tx.taskAssignment.createMany({
          data: dto.assigneeIds.map((uid) => ({
            taskId: created.id,
            userId: uid,
          })),
          skipDuplicates: true,
        });
      }

      // Create label associations
      if (dto.labelIds?.length) {
        await tx.taskLabel.createMany({
          data: dto.labelIds.map((labelId) => ({
            taskId: created.id,
            labelId,
          })),
          skipDuplicates: true,
        });
      }

      // H6: gate — una tarea nueva nunca tiene horas → bloquear nacer en IN_REVIEW/DONE
      // salvo escape auditado (manage:projects o auto-asignarse) + motivo. Corre tras crear
      // task+assignments para que el chequeo de "asignado" del escape vea las asignaciones;
      // si lanza, la tx entera se revierte y la tarea no queda creada.
      if (this.hoursGuard.isGatedStatus(created.status)) {
        await this.hoursGuard.enforce({
          task: {
            id: created.id,
            status: created.status,
            title: created.title,
            organizationId: project.organizationId,
          },
          targetStatus: created.status,
          actor: { id: userId, ...actor },
          closeWithoutHours: dto.closeWithoutHours,
          closeWithoutHoursReason: dto.closeWithoutHoursReason,
          tx,
        });
      }

      // Re-fetch with all relations
      return tx.task.findUnique({
        where: { id: created.id },
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: true,
          role: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true, email: true, image: true } },
        },
      });
    }, {
      maxWait: 10_000,
      timeout: 30_000,
    });

    this.eventEmitter.emit('task.created', {
      ...domainEvent('task.created', 'task', task!.id, project.organizationId, userId, { title: task!.title, projectId }),
      task,
    });

    // Emit task.assigned por cada asignado inicial (mismo evento que assignTask posterior)
    // Esto dispara notificaciones in-app + push + email respetando preferencias del usuario.
    if (dto.assigneeIds?.length) {
      for (const assigneeId of dto.assigneeIds) {
        this.eventEmitter.emit('task.assigned', {
          ...domainEvent('task.assigned', 'task', task!.id, project.organizationId, userId, {
            taskTitle: task!.title,
            assigneeId,
            projectId,
          }),
          taskId: task!.id,
          taskTitle: task!.title,
          assigneeId,
          assignedById: userId,
          projectId,
        });
      }
    }

    this.logger.log(`Task created: ${task!.id} in project ${projectId}`);

    return task;
  }

  private static readonly SENIOR_ROLES = ['Owner', 'Product Owner', 'Project Manager', 'Tech Lead'];

  async getTasks(
    projectId: string,
    filters: TaskFilterDto,
    roleContext?: { userId?: string; roleId?: string; roleName?: string },
  ): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 20, sort, search, status, priority, assigneeId, sprintId } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.TaskWhereInput = {
      projectId,
      ...(status?.length && { status: { in: status } }),
      ...(priority?.length && { priority: { in: priority } }),
      ...(sprintId && { sprintId }),
      ...(assigneeId && {
        assignments: {
          some: { userId: assigneeId },
        },
      }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    // Role-based visibility filter
    if (
      roleContext?.roleName &&
      !TaskService.SENIOR_ROLES.includes(roleContext.roleName) &&
      roleContext.userId &&
      roleContext.roleId
    ) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { roleId: roleContext.roleId },
            { roleId: null },
            { assignments: { some: { userId: roleContext.userId } } },
          ],
        },
      ];
    }

    // Parse sort field
    const orderBy = this.parseSortField(sort);

    const [tasks, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: { select: { id: true, name: true, status: true } },
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          role: { select: { id: true, name: true } },
          _count: { select: { subTasks: true, comments: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return { data: tasks, total, page, limit };
  }

  async getTaskById(taskId: string, organizationId?: string) {
    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        ...(organizationId && { project: { organizationId } }),
      },
      include: {
        project: { select: { id: true, name: true, slug: true, organizationId: true } },
        assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
        taskLabels: { include: { label: true } },
        boardColumn: true,
        sprint: true,
        role: { select: { id: true, name: true } },
        parentTask: { select: { id: true, title: true, status: true } },
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        subTasks: {
          select: {
            id: true, title: true, status: true, priority: true, position: true,
            assignments: { select: { user: { select: { id: true, name: true, image: true } } } },
          },
          orderBy: { position: 'asc' },
          take: 50,
        },
        timeEntries: {
          where: { deletedAt: null }, // H4: soft delete — las borradas no se listan ni suman al total
          select: { id: true, startTime: true, endTime: true, duration: true, description: true, status: true, billable: true, legacyMigration: true, minutes: true, workedOn: true, origin: true, createdById: true, correctedById: true, correctedAt: true, previousMinutes: true, correctionNote: true, deletedAt: true, user: { select: { id: true, name: true, image: true } } },
          orderBy: { startTime: 'desc' },
          take: 50,
        },
        files: {
          select: { id: true, originalName: true, mimeType: true, size: true, url: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 30,
        },
        _count: { select: { subTasks: true, comments: true, timeEntries: true } },
      },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    // Compute total duration from time entries
    const totalDuration = task.timeEntries.reduce((acc, entry) => acc + (entry.duration || 0), 0);

    return { ...task, totalDuration };
  }

  async updateTask(taskId: string, dto: UpdateTaskDto, userId: string, organizationId?: string, actor?: HoursGateActorContext) {
    const taskForFreeze = await this.prisma.task.findFirst({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (taskForFreeze) {
      await this.projectService.assertProjectNotFrozen(taskForFreeze.projectId);
    }

    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        ...(organizationId && { project: { organizationId } }),
      },
      include: { project: { select: { organizationId: true } } },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    // Validate SUPPORT hours availability when estimatedHours changes
    if (dto.estimatedHours !== undefined && (task as any).type === 'SUPPORT') {
      await this.assertSupportHoursAvailable(task.projectId, dto.estimatedHours, taskId);
    }

    // Backfill originalEstimate la primera vez que se setean horas (es inmutable, solo para varianza)
    const shouldBackfillOriginal =
      dto.estimatedHours !== undefined &&
      dto.estimatedHours !== null &&
      dto.estimatedHours > 0 &&
      !(task as any).originalEstimate;

    const oldData = { status: task.status, priority: task.priority, title: task.title };
    const transitionRef: { ticket: { id: string; title: string; projectId: string; clientId: string } | null } = { ticket: null };

    const updated = await this.prisma.$transaction(async (tx) => {
      // Build update payload
      const updatePayload: Record<string, unknown> = {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        type: dto.type,
        storyPoints: dto.storyPoints,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        estimatedHours: dto.estimatedHours,
        hourlyRate: dto.hourlyRate,
        roleId: dto.roleId,
        boardColumnId: dto.boardColumnId,
        sprintId: dto.sprintId,
        clientVisible: dto.clientVisible,
        billable: dto.billable,
        ...(shouldBackfillOriginal && { originalEstimate: dto.estimatedHours }),
      };

      // Validate status transitions — DONE requires approval (must go through IN_REVIEW first)
      if (dto.status && dto.status !== task.status) {
        const blockedWithoutApproval = ['DONE'];
        if (blockedWithoutApproval.includes(dto.status) && task.status !== 'IN_REVIEW') {
          throw new AppException(
            'La tarea debe estar en revisión (IN_REVIEW) y ser aprobada antes de pasar a este estado',
            'INVALID_STATUS_TRANSITION',
            400,
            { currentStatus: task.status, targetStatus: dto.status },
          );
        }
        if (dto.status === 'DONE' && task.status === 'IN_REVIEW') {
          throw new AppException(
            'La tarea debe ser aprobada explícitamente usando el botón de aprobar, no puede cambiar a DONE directamente',
            'APPROVAL_REQUIRED',
            400,
            { currentStatus: task.status, targetStatus: dto.status },
          );
        }

        // H6: gate de horas — no pasar a IN_REVIEW/DONE sin horas reales, salvo escape
        // auditado (asignado o manage:projects + motivo). Corre dentro de la misma tx.
        if (this.hoursGuard.isGatedStatus(dto.status)) {
          await this.hoursGuard.enforce({
            task: {
              id: taskId,
              status: task.status,
              title: task.title,
              organizationId: task.project.organizationId,
            },
            targetStatus: dto.status,
            actor: { id: userId, ...actor },
            closeWithoutHours: dto.closeWithoutHours,
            closeWithoutHoursReason: dto.closeWithoutHoursReason,
            tx,
          });
        }

        // H8c: no reabrir una tarea con horas ya facturadas (el revert devolvería el
        // cupo mientras la factura ya cobró la plata). Choke-point en la transición,
        // dentro de la misma tx y antes de escribir el estado → el listener de revert
        // nunca llega para tareas facturadas. Candado hasta H9 (nota de crédito).
        if (task.status === 'DONE' && dto.status !== 'DONE') {
          await this.hoursGuard.assertNotBilled(taskId, tx);
        }

        // Auto-set startDate al pasar a IN_PROGRESS (si no tenía valor manual)
        if (dto.status === 'IN_PROGRESS' && !task.startDate && updatePayload.startDate === undefined) {
          updatePayload.startDate = new Date();
        }
        // Auto-set endDate al pasar a DONE (si no tenía valor manual)
        if (dto.status === 'DONE' && !task.endDate) {
          updatePayload.endDate = new Date();
        }

        // Reverse sync: find matching board column and update boardColumnId
        const matchingColumn = await tx.boardColumn.findFirst({
          where: {
            mappedStatus: dto.status,
            board: {
              projectId: task.projectId,
            },
          },
          orderBy: { position: 'asc' },
        });
        if (matchingColumn) {
          updatePayload.boardColumnId = matchingColumn.id;
        }
      }

      const result = await tx.task.update({
        where: { id: taskId },
        data: updatePayload,
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: true,
          createdBy: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      // Update assignments if provided
      if (dto.assigneeIds !== undefined) {
        await tx.taskAssignment.deleteMany({ where: { taskId } });
        if (dto.assigneeIds.length > 0) {
          await tx.taskAssignment.createMany({
            data: dto.assigneeIds.map((uid) => ({ taskId, userId: uid })),
            skipDuplicates: true,
          });

          // Auto-transition: Ticket OPEN → IN_PROGRESS when task gets assignees
          const linkedTicket = await tx.ticket.findUnique({
            where: { taskId },
            select: { id: true, status: true, firstResponseAt: true, title: true, projectId: true, clientId: true },
          });

          if (linkedTicket && linkedTicket.status === 'OPEN') {
            await tx.ticket.update({
              where: { id: linkedTicket.id },
              data: {
                status: 'IN_PROGRESS',
                ...(!linkedTicket.firstResponseAt && { firstResponseAt: new Date() }),
              },
            });
            transitionRef.ticket = {
              id: linkedTicket.id,
              title: linkedTicket.title,
              projectId: linkedTicket.projectId,
              clientId: linkedTicket.clientId,
            };
          }
        }
      }

      // Update labels if provided
      if (dto.labelIds !== undefined) {
        await tx.taskLabel.deleteMany({ where: { taskId } });
        if (dto.labelIds.length > 0) {
          await tx.taskLabel.createMany({
            data: dto.labelIds.map((labelId) => ({ taskId, labelId })),
            skipDuplicates: true,
          });
        }
      }

      // Re-fetch with all relations
      return tx.task.findUnique({
        where: { id: taskId },
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: true,
          createdBy: { select: { id: true, name: true, email: true, image: true } },
        },
      });
    }, {
      maxWait: 10_000,
      timeout: 30_000,
    });

    // Emit ticket transition event (outside transaction — fire & forget)
    if (transitionRef.ticket) {
      this.eventEmitter.emit('ticket.updated', {
        ticketId: transitionRef.ticket.id,
        title: transitionRef.ticket.title,
        status: 'IN_PROGRESS',
        projectId: transitionRef.ticket.projectId,
        clientId: transitionRef.ticket.clientId,
      });
    }

    // Emit specific status change event for activity log
    if (dto.status && dto.status !== task.status) {
      this.eventEmitter.emit('task.status.changed', {
        ...domainEvent('task.status.changed', 'task', taskId, task.project.organizationId, userId, {
          title: updated!.title,
          projectId: task.projectId,
          fromStatus: task.status,
          toStatus: dto.status,
        }, { status: task.status }),
      });
    }

    this.eventEmitter.emit('task.updated', {
      ...domainEvent('task.updated', 'task', taskId, task.project.organizationId, userId, { title: updated!.title, status: updated!.status, projectId: task.projectId }, oldData),
      task: updated,
      previousStatus: task.status,
    });

    // Emit approval requested when task moves to IN_REVIEW
    if (dto.status === 'IN_REVIEW' && task.status !== 'IN_REVIEW') {
      this.eventEmitter.emit('task.approval.requested', {
        ...domainEvent('task.approval.requested', 'task', taskId, task.project.organizationId, userId),
        taskId,
        taskTitle: updated!.title,
        projectId: task.projectId,
        userId,
      });
    }

    // Emit task.reopened when status changes FROM DONE to another status (reverse hours)
    if (task.status === 'DONE' && dto.status && dto.status !== 'DONE') {
      this.eventEmitter.emit('task.reopened', {
        ...domainEvent('task.reopened', 'task', taskId, task.project.organizationId, userId, { title: updated!.title, projectId: task.projectId }),
        task: { ...updated, type: (updated as any).type, projectId: task.projectId },
      });
    }

    // Cross-role comment al completar (mantenido — el emit task.completed se elimino en Fase B,
    // el descuento al cliente ahora sale de time_entry.confirmed via HoursListener)
    if (dto.status === 'DONE' && task.status !== 'DONE') {
      const taskWithRole = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { roleId: true, role: { select: { name: true } } },
      });
      if (taskWithRole?.roleId) {
        const userMembership = await this.prisma.organizationMember.findFirst({
          where: { userId, organizationId: task.project.organizationId },
          select: { roleId: true, role: { select: { name: true } } },
        });
        if (userMembership?.roleId && userMembership.roleId !== taskWithRole.roleId) {
          const userName = (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || 'Usuario';
          await this.prisma.comment.create({
            data: {
              taskId,
              userId,
              content: `Tarea completada por ${userName} (rol: ${userMembership.role?.name}) — asignada originalmente al rol ${taskWithRole.role?.name}`,
            },
          });
        }
      }
    }

    return updated;
  }

  async deleteTask(taskId: string, userId: string, organizationId?: string) {
    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        ...(organizationId && { project: { organizationId } }),
      },
      include: { project: { select: { organizationId: true } } },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    this.eventEmitter.emit('task.deleted', {
      ...domainEvent('task.deleted', 'task', taskId, task.project.organizationId, userId, { title: task.title, projectId: task.projectId }),
    });
    this.logger.log(`Task deleted: ${taskId}`);
  }

  // ============================================
  // SUBTASKS
  // ============================================

  async createSubtask(parentTaskId: string, dto: CreateTaskDto, userId: string, actor?: HoursGateActorContext) {
    const parentTask = await this.prisma.task.findUnique({
      where: { id: parentTaskId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!parentTask) {
      throw new TaskNotFoundException(parentTaskId);
    }

    const subtask = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          projectId: parentTask.projectId,
          parentTaskId,
          title: dto.title,
          description: dto.description,
          status: dto.status,
          priority: dto.priority ?? parentTask.priority,
          storyPoints: dto.storyPoints,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          estimatedHours: dto.estimatedHours,
          hourlyRate: dto.hourlyRate,
          boardColumnId: dto.boardColumnId ?? parentTask.boardColumnId,
          sprintId: dto.sprintId ?? parentTask.sprintId,
          position: 0,
          createdById: userId,
        },
        include: {
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          createdBy: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      // H6: una subtarea nueva nunca tiene horas → mismo gate que createTask.
      if (this.hoursGuard.isGatedStatus(created.status)) {
        await this.hoursGuard.enforce({
          task: {
            id: created.id,
            status: created.status,
            title: created.title,
            organizationId: parentTask.project.organizationId,
          },
          targetStatus: created.status,
          actor: { id: userId, ...actor },
          closeWithoutHours: dto.closeWithoutHours,
          closeWithoutHoursReason: dto.closeWithoutHoursReason,
          tx,
        });
      }

      return created;
    });

    this.eventEmitter.emit('subtask.created', {
      ...domainEvent('subtask.created', 'task', subtask.id, parentTask.project.organizationId, userId, { title: subtask.title, parentTaskId, projectId: parentTask.projectId }),
      subtask,
    });

    return subtask;
  }

  async getSubtasks(parentTaskId: string) {
    const parentTask = await this.prisma.task.findUnique({
      where: { id: parentTaskId },
    });

    if (!parentTask) {
      throw new TaskNotFoundException(parentTaskId);
    }

    return this.prisma.task.findMany({
      where: { parentTaskId },
      include: {
        assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
        taskLabels: { include: { label: true } },
        createdBy: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { position: 'asc' },
    });
  }

  // ============================================
  // MY TASKS (cross-project)
  // ============================================

  async getMyTasks(userId: string, organizationId: string, filters: TaskFilterDto): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 20, sort, search, status, priority } = filters;
    const skip = (page - 1) * limit;

    const where: Prisma.TaskWhereInput = {
      assignments: { some: { userId } },
      status: { not: 'CANCELLED' },
      ...(organizationId && { project: { organizationId, lifecycleStatus: 'ACTIVE' } }),
      ...(status?.length && { status: { in: status } }),
      ...(priority?.length && { priority: { in: priority } }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const orderBy = this.parseSortField(sort);

    const [tasks, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        include: {
          project: { select: { id: true, name: true, slug: true } },
          assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
          taskLabels: { include: { label: true } },
          boardColumn: true,
          sprint: { select: { id: true, name: true, status: true } },
          role: { select: { id: true, name: true } },
          _count: { select: { subTasks: true, comments: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return { data: tasks, total, page, limit };
  }

  // ============================================
  // HELPERS
  // ============================================

  private parseSortField(sort?: string): Prisma.TaskOrderByWithRelationInput {
    if (!sort) {
      return { createdAt: 'desc' };
    }

    const isDesc = sort.startsWith('-');
    const field = isDesc ? sort.slice(1) : sort;
    const direction = isDesc ? 'desc' : 'asc';

    const allowedFields = ['createdAt', 'updatedAt', 'title', 'status', 'priority', 'dueDate', 'position', 'storyPoints'];

    if (allowedFields.includes(field)) {
      return { [field]: direction };
    }

    return { createdAt: 'desc' };
  }
}
