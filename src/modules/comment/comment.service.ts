import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateCommentDto, UpdateCommentDto } from './dto';

@Injectable()
export class CommentService {
  private readonly logger = new Logger(CommentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async create(taskId: string, dto: CreateCommentDto, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } },
    });
    if (!task) throw new AppException('Tarea no encontrada', 'TASK_NOT_FOUND', 404, { taskId });

    const comment = await this.prisma.comment.create({
      data: {
        taskId,
        userId,
        content: dto.content,
        parentCommentId: dto.parentCommentId || null,
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
        attachments: true,
      },
    });

    this.events.emit('comment.created', {
      type: 'create',
      entity: 'comment',
      entityId: comment.id,
      organizationId: task.project.organizationId,
      userId,
      data: {
        taskId,
        content: dto.content,
      },
    });

    this.logger.log(`Comment created: ${comment.id} on task ${taskId}`);

    return comment;
  }

  async findByTask(taskId: string, page = 1, limit = 50) {
    const [data, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { taskId, parentCommentId: null },
        include: {
          user: { select: { id: true, name: true, image: true } },
          attachments: true,
          replies: {
            include: {
              user: { select: { id: true, name: true, image: true } },
              attachments: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.comment.count({ where: { taskId, parentCommentId: null } }),
    ]);

    return { data, total, page, limit };
  }

  async update(commentId: string, dto: UpdateCommentDto, userId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { task: { select: { project: { select: { organizationId: true } } } } },
    });
    if (!comment) throw new AppException('Comentario no encontrado', 'COMMENT_NOT_FOUND', 404, { commentId });
    if (comment.userId !== userId) throw new AppException('No puedes editar este comentario', 'FORBIDDEN', 403);

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        content: dto.content,
        editedAt: new Date(),
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
        attachments: true,
      },
    });

    this.events.emit('comment.updated', {
      type: 'update',
      entity: 'comment',
      entityId: commentId,
      organizationId: comment.task.project.organizationId,
      userId,
      data: { content: dto.content },
      oldData: { content: comment.content },
    });

    return updated;
  }

  async delete(commentId: string, userId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { task: { select: { project: { select: { organizationId: true } } } } },
    });
    if (!comment) throw new AppException('Comentario no encontrado', 'COMMENT_NOT_FOUND', 404, { commentId });
    if (comment.userId !== userId) throw new AppException('No puedes eliminar este comentario', 'FORBIDDEN', 403);

    await this.prisma.comment.delete({ where: { id: commentId } });

    this.events.emit('comment.deleted', {
      type: 'delete',
      entity: 'comment',
      entityId: commentId,
      organizationId: comment.task.project.organizationId,
      userId,
      data: { taskId: comment.taskId },
    });

    this.logger.log(`Comment deleted: ${commentId}`);
  }
}
