import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException, TaskNotFoundException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { domainEvent } from '../../common/events/domain-event.helper';
import {
  CreateTaskDto,
  UpdateTaskDto,
  TaskFilterDto,
  BulkUpdateTaskDto,
} from './dto';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createTask(projectId: string, dto: CreateTaskDto, userId: string) {
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

  async getTasks(projectId: string, filters: TaskFilterDto): Promise<PaginatedResult<any>> {
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

  async getTaskById(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
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
          include: {
            assignments: { include: { user: { select: { id: true, name: true, image: true } } } },
          },
          orderBy: { position: 'asc' },
        },
        timeEntries: {
          include: { user: { select: { id: true, name: true, image: true } } },
          orderBy: { startTime: 'desc' },
        },
        files: {
          orderBy: { createdAt: 'desc' },
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

  async updateTask(taskId: string, dto: UpdateTaskDto, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
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

    // Emit task.completed when status changes to DONE
    if (dto.status === 'DONE' && task.status !== 'DONE') {
      this.eventEmitter.emit('task.completed', {
        ...domainEvent('task.completed', 'task', taskId, task.project.organizationId, userId, { title: updated!.title, projectId: task.projectId }),
        task: updated,
      });
    }

    return updated;
  }

  async deleteTask(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    // Soft delete: set status to CANCELLED
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'CANCELLED' },
    });

    this.eventEmitter.emit('task.deleted', {
      ...domainEvent('task.deleted', 'task', taskId, task.project.organizationId, userId, { title: task.title, projectId: task.projectId }),
    });
    this.logger.log(`Task soft-deleted: ${taskId}`);
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
  // ASSIGNMENTS
  // ============================================

  async assignTask(taskId: string, userId: string, requesterId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const assignment = await this.prisma.taskAssignment.create({
      data: { taskId, userId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    this.eventEmitter.emit('task.assigned', {
      ...domainEvent('task.assigned', 'task', taskId, task.project.organizationId, requesterId, { taskTitle: task.title, assigneeId: userId, projectId: task.projectId }),
      taskId,
      taskTitle: task.title,
      assigneeId: userId,
      assignedById: requesterId,
      projectId: task.projectId,
    });

    return assignment;
  }

  async unassignTask(taskId: string, userId: string, requesterId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const assignment = await this.prisma.taskAssignment.findUnique({
      where: { taskId_userId: { taskId, userId } },
    });

    if (!assignment) {
      throw new AppException(
        'El usuario no esta asignado a esta tarea',
        'ASSIGNMENT_NOT_FOUND',
        404,
        { taskId, userId },
      );
    }

    await this.prisma.taskAssignment.delete({
      where: { taskId_userId: { taskId, userId } },
    });

    this.eventEmitter.emit('task.unassigned', {
      ...domainEvent('task.unassigned', 'task', taskId, task.project.organizationId, requesterId, { userId, projectId: task.projectId }),
    });
  }

  // ============================================
  // LABELS
  // ============================================

  async addLabel(taskId: string, labelId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const taskLabel = await this.prisma.taskLabel.create({
      data: { taskId, labelId },
      include: { label: true },
    });

    this.eventEmitter.emit('task.label.added', {
      ...domainEvent('task.label.added', 'task', taskId, task.project.organizationId, userId, { labelId }),
    });

    return taskLabel;
  }

  async removeLabel(taskId: string, labelId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { organizationId: true } } } });
    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    const taskLabel = await this.prisma.taskLabel.findUnique({
      where: { taskId_labelId: { taskId, labelId } },
    });

    if (!taskLabel) {
      throw new AppException(
        'La etiqueta no esta asociada a esta tarea',
        'LABEL_NOT_FOUND',
        404,
        { taskId, labelId },
      );
    }

    await this.prisma.taskLabel.delete({
      where: { taskId_labelId: { taskId, labelId } },
    });

    this.eventEmitter.emit('task.label.removed', {
      ...domainEvent('task.label.removed', 'task', taskId, task.project.organizationId, userId, { labelId }),
    });
  }

  // ============================================
  // BULK OPERATIONS
  // ============================================

  async bulkUpdate(projectId: string, dto: BulkUpdateTaskDto, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    const results = await this.prisma.$transaction(
      dto.operations.map((op) =>
        this.prisma.task.update({
          where: { id: op.taskId },
          data: {
            ...(op.status && { status: op.status }),
            ...(op.priority && { priority: op.priority }),
            ...(op.sprintId !== undefined && { sprintId: op.sprintId }),
          },
          include: {
            assignments: { include: { user: { select: { id: true, name: true, email: true, image: true } } } },
            taskLabels: { include: { label: true } },
          },
        }),
      ),
    );

    this.eventEmitter.emit('tasks.bulk.updated', {
      ...domainEvent('tasks.bulk.updated', 'task', projectId, project?.organizationId || '', userId, { count: results.length, projectId }),
    });
    this.logger.log(`Bulk updated ${results.length} tasks in project ${projectId}`);

    return results;
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
      ...(organizationId && { project: { organizationId } }),
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
  // APPROVALS
  // ============================================

  async approveTask(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, responsibleId: true, organizationId: true } },
        assignments: { select: { userId: true } },
      },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    if (task.status !== 'IN_REVIEW') {
      throw new AppException(
        'Solo se pueden aprobar tareas en estado Testing (IN_REVIEW)',
        'INVALID_TASK_STATUS',
        400,
      );
    }

    // Find Deploy column (mappedStatus DONE, first one by position)
    const deployColumn = await this.prisma.boardColumn.findFirst({
      where: {
        board: { projectId: task.projectId },
        mappedStatus: 'DONE',
      },
      orderBy: { position: 'asc' },
    });

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        ...(deployColumn && { boardColumnId: deployColumn.id }),
      },
    });

    this.eventEmitter.emit('task.approval.approved', {
      ...domainEvent('task.approval.approved', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, projectName: task.project.name }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      approvedById: userId,
      assigneeIds: task.assignments.map((a) => a.userId),
    });

    return updated;
  }

  async rejectTask(taskId: string, reason: string | undefined, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true, responsibleId: true, organizationId: true } },
        assignments: { select: { userId: true } },
      },
    });

    if (!task) {
      throw new TaskNotFoundException(taskId);
    }

    if (task.status !== 'IN_REVIEW') {
      throw new AppException(
        'Solo se pueden rechazar tareas en estado Testing (IN_REVIEW)',
        'INVALID_TASK_STATUS',
        400,
      );
    }

    // Find Desarrollo column (mappedStatus IN_PROGRESS)
    const desarrolloColumn = await this.prisma.boardColumn.findFirst({
      where: {
        board: { projectId: task.projectId },
        mappedStatus: 'IN_PROGRESS',
      },
      orderBy: { position: 'asc' },
    });

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'IN_PROGRESS',
        reviewAttempts: { increment: 1 },
        ...(desarrolloColumn && { boardColumnId: desarrolloColumn.id }),
      },
    });

    this.eventEmitter.emit('task.approval.rejected', {
      ...domainEvent('task.approval.rejected', 'task', task.id, task.project.organizationId, userId, { taskTitle: task.title, projectId: task.projectId, reason: reason || '' }),
      taskId: task.id,
      taskTitle: task.title,
      projectId: task.projectId,
      projectName: task.project.name,
      rejectedById: userId,
      reason: reason || '',
      reviewAttempts: updated.reviewAttempts,
      assigneeIds: task.assignments.map((a) => a.userId),
    });

    return updated;
  }

  async findPendingApprovalsByProject(projectId: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'IN_REVIEW',
        projectId,
      },
      include: {
        project: { select: { id: true, name: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
        boardColumn: { select: { id: true, name: true, color: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      reviewAttempts: t.reviewAttempts,
      updatedAt: t.updatedAt,
      project: t.project,
      assignees: t.assignments.map((a) => a.user),
      column: t.boardColumn,
    }));
  }

  async findPendingApprovals(orgId: string) {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'IN_REVIEW',
        project: { organizationId: orgId },
      },
      include: {
        project: { select: { id: true, name: true } },
        assignments: {
          select: { user: { select: { id: true, name: true } } },
        },
        boardColumn: { select: { id: true, name: true, color: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      reviewAttempts: t.reviewAttempts,
      updatedAt: t.updatedAt,
      project: t.project,
      assignees: t.assignments.map((a) => a.user),
      column: t.boardColumn,
    }));
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
