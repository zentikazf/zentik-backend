import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { domainEvent } from '../../common/events/domain-event.helper';
import { ProjectService } from '../project/project.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  TaskFilterDto,
} from './dto';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly projectService: ProjectService,
  ) {}

  async createTask(projectId: string, dto: CreateTaskDto, userId: string) {
    await this.projectService.assertProjectNotFrozen(projectId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404, { projectId });
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const maxPosition = await tx.task.aggregate({
        where: { projectId },
        _max: { position: true },
      });

      const created = await tx.task.create({
        data: {
          projectId,
          title: dto.title,
          description: dto.description,
          status: dto.status,
          priority: dto.priority,
          storyPoints: dto.storyPoints,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          estimatedHours: dto.estimatedHours,
          hourlyRate: dto.hourlyRate,
          roleId: dto.roleId,
          boardColumnId: dto.boardColumnId,
          sprintId: dto.sprintId,
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
    });

    this.eventEmitter.emit('task.created', {
      ...domainEvent('task.created', 'task', task!.id, project.organizationId, userId, { title: task!.title, projectId }),
      task,
    });
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
          select: { id: true, startTime: true, endTime: true, duration: true, description: true, user: { select: { id: true, name: true, image: true } } },
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

  async updateTask(taskId: string, dto: UpdateTaskDto, userId: string, organizationId?: string) {
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

    const oldData = { status: task.status, priority: task.priority, title: task.title };

    const updated = await this.prisma.$transaction(async (tx) => {
      // Build update payload
      const updatePayload: Record<string, unknown> = {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        storyPoints: dto.storyPoints,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        estimatedHours: dto.estimatedHours,
        hourlyRate: dto.hourlyRate,
        roleId: dto.roleId,
        boardColumnId: dto.boardColumnId,
        sprintId: dto.sprintId,
        clientVisible: dto.clientVisible,
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
    });

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

    // Emit task.completed when status changes to DONE (include type for hours listener)
    if (dto.status === 'DONE' && task.status !== 'DONE') {
      this.eventEmitter.emit('task.completed', {
        ...domainEvent('task.completed', 'task', taskId, task.project.organizationId, userId, { title: updated!.title, projectId: task.projectId }),
        task: { ...updated, type: (updated as any).type },
      });

      // Cross-role comment: log when user completes a task assigned to a different role
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

  async createSubtask(parentTaskId: string, dto: CreateTaskDto, userId: string) {
    const parentTask = await this.prisma.task.findUnique({
      where: { id: parentTaskId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!parentTask) {
      throw new TaskNotFoundException(parentTaskId);
    }

    const subtask = await this.prisma.task.create({
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
