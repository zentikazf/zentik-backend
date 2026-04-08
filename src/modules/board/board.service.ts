import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import {
  CreateBoardDto,
  UpdateBoardDto,
  CreateColumnDto,
  UpdateColumnDto,
  ReorderColumnsDto,
  MoveTaskDto,
} from './dto';
import { TaskStatus } from '@prisma/client';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createBoard(projectId: string, dto: CreateBoardDto, userId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true },
    });

    if (!project) {
      throw new AppException('El proyecto no existe', 'PROJECT_NOT_FOUND', 404, { projectId });
    }

    const maxPosition = await this.prisma.board.aggregate({
      where: { projectId },
      _max: { position: true },
    });

    const defaultColumns = [
      { name: 'Por hacer',    position: 0, color: '#8B5CF6', mappedStatus: 'BACKLOG' as TaskStatus },
      { name: 'En progreso',  position: 1, color: '#F59E0B', mappedStatus: 'IN_PROGRESS' as TaskStatus },
      { name: 'En revision',  position: 2, color: '#10B981', mappedStatus: 'IN_REVIEW' as TaskStatus },
      { name: 'Hecho',        position: 3, color: '#06B6D4', mappedStatus: 'DONE' as TaskStatus },
    ];

    const board = await this.prisma.$transaction(async (tx) => {
      const newBoard = await tx.board.create({
        data: {
          projectId,
          name: dto.name,
          position: (maxPosition._max.position ?? -1) + 1,
        },
      });

      await tx.boardColumn.createMany({
        data: defaultColumns.map((col) => ({
          boardId: newBoard.id,
          ...col,
        })),
      });

      return tx.board.findUnique({
        where: { id: newBoard.id },
        include: { columns: { orderBy: { position: 'asc' } } },
      });
    });

    this.eventEmitter.emit('board.created', {
      ...domainEvent('board.created', 'board', board!.id, project!.organizationId, userId),
      board,
      userId,
    });
    this.logger.log(`Board created: ${board!.id} in project ${projectId}`);

    return board;
  }

  async getBoards(projectId: string) {
    return this.prisma.board.findMany({
      where: { projectId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { position: 'asc' },
    });
  }

  async getBoardWithDetails(projectId: string, boardId: string) {
    const board = await this.prisma.board.findFirst({
      where: { id: boardId, projectId },
      include: {
        columns: {
          orderBy: { position: 'asc' },
          include: {
            tasks: {
              orderBy: { position: 'asc' },
              include: {
                assignments: {
                  include: {
                    user: {
                      select: { id: true, name: true, email: true, image: true },
                    },
                  },
                },
                taskLabels: {
                  include: { label: true },
                },
                subTasks: {
                  select: { status: true },
                },
                _count: {
                  select: { subTasks: true },
                },
              },
            },
          },
        },
      },
    });

    if (!board) {
      throw new AppException('El tablero no existe', 'BOARD_NOT_FOUND', 404, { boardId });
    }

    return board;
  }

  async updateBoard(projectId: string, boardId: string, dto: UpdateBoardDto, userId: string) {
    const board = await this.prisma.board.findFirst({
      where: { id: boardId, projectId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!board) {
      throw new AppException('El tablero no existe', 'BOARD_NOT_FOUND', 404, { boardId });
    }

    const updated = await this.prisma.board.update({
      where: { id: boardId },
      data: { ...dto },
      include: { columns: { orderBy: { position: 'asc' } } },
    });

    this.eventEmitter.emit('board.updated', {
      ...domainEvent('board.updated', 'board', updated.id, board!.project.organizationId, userId),
      board: updated,
      userId,
    });

    return updated;
  }

  async deleteBoard(projectId: string, boardId: string, userId: string) {
    const board = await this.prisma.board.findFirst({
      where: { id: boardId, projectId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!board) {
      throw new AppException('El tablero no existe', 'BOARD_NOT_FOUND', 404, { boardId });
    }

    await this.prisma.board.delete({ where: { id: boardId } });

    this.eventEmitter.emit('board.deleted', {
      ...domainEvent('board.deleted', 'board', boardId, board!.project.organizationId, userId),
      boardId,
      projectId,
      userId,
    });
    this.logger.log(`Board deleted: ${boardId}`);
  }

  // ============================================
  // COLUMN MANAGEMENT
  // ============================================

  async createColumn(boardId: string, dto: CreateColumnDto, userId: string) {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!board) {
      throw new AppException('El tablero no existe', 'BOARD_NOT_FOUND', 404, { boardId });
    }

    const column = await this.prisma.boardColumn.create({
      data: {
        boardId,
        name: dto.name,
        position: dto.position,
        color: dto.color,
        taskLimit: dto.wipLimit,
        mappedStatus: dto.mappedStatus,
      },
    });

    this.eventEmitter.emit('column.created', {
      ...domainEvent('column.created', 'column', column.id, board!.project.organizationId, userId),
      column,
      userId,
    });

    return column;
  }

  async updateColumn(boardId: string, columnId: string, dto: UpdateColumnDto, userId: string) {
    const column = await this.prisma.boardColumn.findFirst({
      where: { id: columnId, boardId },
      include: { board: { select: { project: { select: { organizationId: true } } } } },
    });

    if (!column) {
      throw new AppException('La columna no existe', 'COLUMN_NOT_FOUND', 404, { columnId });
    }

    const updated = await this.prisma.boardColumn.update({
      where: { id: columnId },
      data: {
        name: dto.name,
        position: dto.position,
        color: dto.color,
        taskLimit: dto.wipLimit,
        mappedStatus: dto.mappedStatus,
      },
    });

    this.eventEmitter.emit('column.updated', {
      ...domainEvent('column.updated', 'column', updated.id, column!.board.project.organizationId, userId),
      column: updated,
      userId,
    });

    return updated;
  }

  async deleteColumn(boardId: string, columnId: string, userId: string) {
    const column = await this.prisma.boardColumn.findFirst({
      where: { id: columnId, boardId },
      include: { board: { select: { project: { select: { organizationId: true } } } } },
    });

    if (!column) {
      throw new AppException('La columna no existe', 'COLUMN_NOT_FOUND', 404, { columnId });
    }

    await this.prisma.boardColumn.delete({ where: { id: columnId } });

    this.eventEmitter.emit('column.deleted', {
      ...domainEvent('column.deleted', 'column', columnId, column!.board.project.organizationId, userId),
      columnId,
      boardId,
      userId,
    });
  }

  async reorderColumns(boardId: string, dto: ReorderColumnsDto, userId: string) {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!board) {
      throw new AppException('El tablero no existe', 'BOARD_NOT_FOUND', 404, { boardId });
    }

    await this.prisma.$transaction(
      dto.columnIds.map((columnId, index) =>
        this.prisma.boardColumn.update({
          where: { id: columnId },
          data: { position: index },
        }),
      ),
    );

    this.eventEmitter.emit('columns.reordered', {
      ...domainEvent('columns.reordered', 'column', boardId, board!.project.organizationId, userId),
      boardId,
      columnIds: dto.columnIds,
      userId,
    });

    return this.prisma.boardColumn.findMany({
      where: { boardId },
      orderBy: { position: 'asc' },
    });
  }

  async moveTask(boardId: string, dto: MoveTaskDto, userId: string) {
    const targetColumn = await this.prisma.boardColumn.findFirst({
      where: { id: dto.targetColumnId, boardId },
      select: { id: true, mappedStatus: true },
    });

    if (!targetColumn) {
      throw new AppException(
        'La columna destino no existe en este tablero',
        'COLUMN_NOT_FOUND',
        404,
        { columnId: dto.targetColumnId },
      );
    }

    const task = await this.prisma.task.findUnique({
      where: { id: dto.taskId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!task) {
      throw new AppException('La tarea no existe', 'TASK_NOT_FOUND', 404, { taskId: dto.taskId });
    }

    const previousColumnId = task.boardColumnId;
    const previousStatus = task.status;

    // Block moving to DONE columns (Deploy/Soporte) without approval
    if (targetColumn.mappedStatus === 'DONE' && task.status !== 'IN_REVIEW') {
      throw new AppException(
        'La tarea debe estar en Testing (IN_REVIEW) y ser aprobada antes de moverla a Deploy o Soporte',
        'APPROVAL_REQUIRED',
        400,
        { currentStatus: task.status, targetColumn: targetColumn.mappedStatus },
      );
    }
    if (targetColumn.mappedStatus === 'DONE' && task.status === 'IN_REVIEW') {
      throw new AppException(
        'La tarea debe ser aprobada explícitamente, no puede arrastrarse directamente a Deploy o Soporte',
        'APPROVAL_REQUIRED',
        400,
        { currentStatus: task.status, targetColumn: targetColumn.mappedStatus },
      );
    }

    // Build update data — sync status if column has mappedStatus
    const updateData: Record<string, unknown> = {
      boardColumnId: dto.targetColumnId,
      position: dto.position,
    };

    if (targetColumn.mappedStatus) {
      updateData.status = targetColumn.mappedStatus;

      // Auto-set startDate al pasar a IN_PROGRESS (si no tenía valor manual)
      if (targetColumn.mappedStatus === 'IN_PROGRESS' && !task.startDate) {
        updateData.startDate = new Date();
      }
      // Auto-set endDate al pasar a DONE (si no tenía valor)
      if (targetColumn.mappedStatus === 'DONE' && !task.endDate) {
        updateData.endDate = new Date();
      }
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: dto.taskId },
      data: updateData,
      include: {
        assignments: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true },
            },
          },
        },
        taskLabels: {
          include: { label: true },
        },
      },
    });

    this.eventEmitter.emit('task.moved', {
      ...domainEvent('task.moved', 'board', boardId, task!.project.organizationId, userId),
      task: updatedTask,
      previousColumnId,
      targetColumnId: dto.targetColumnId,
      previousStatus,
      newStatus: targetColumn.mappedStatus || previousStatus,
      userId,
    });

    // Trigger approval request when task moves to Testing (IN_REVIEW)
    if (targetColumn.mappedStatus === 'IN_REVIEW') {
      this.eventEmitter.emit('task.approval.requested', {
        ...domainEvent('task.approval.requested', 'board', boardId, task!.project.organizationId, userId),
        taskId: dto.taskId,
        taskTitle: updatedTask.title,
        projectId: updatedTask.projectId,
        userId,
      });
    }

    return updatedTask;
  }
}
