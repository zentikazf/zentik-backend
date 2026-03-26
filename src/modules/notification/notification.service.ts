import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    userId: string;
    type: string;
    title: string;
    body: string;
    metadata?: Record<string, any>;
  }) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: data.userId,
        type: data.type as any,
        title: data.title,
        message: data.body,
        data: data.metadata ?? {},
      },
    });

    this.logger.log(
      `Notificacion creada: ${notification.id} para usuario ${data.userId}`,
    );

    return notification;
  }

  async findByUser(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return { data, total, page, limit };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });

    return { unreadCount: count };
  }

  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== userId) {
      throw new AppException(
        'La notificacion no existe o no te pertenece',
        'NOTIFICATION_NOT_FOUND',
        404,
      );
    }

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    this.logger.log(
      `${result.count} notificaciones marcadas como leidas para usuario ${userId}`,
    );

    return { updated: result.count };
  }

  async delete(id: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
    });

    if (!notification || notification.userId !== userId) {
      throw new AppException(
        'La notificacion no existe o no te pertenece',
        'NOTIFICATION_NOT_FOUND',
        404,
      );
    }

    return this.prisma.notification.delete({ where: { id } });
  }

  async notifyProjectResponsible(projectId: string, data: {
    type: string;
    title: string;
    body: string;
    metadata?: Record<string, any>;
  }) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { responsibleId: true },
    });

    if (project?.responsibleId) {
      return this.create({ userId: project.responsibleId, ...data });
    }

    return null;
  }

  async notifyTaskAssignees(taskId: string, data: {
    type: string;
    title: string;
    body: string;
    metadata?: Record<string, any>;
  }) {
    const assignments = await this.prisma.taskAssignment.findMany({
      where: { taskId },
      select: { userId: true },
    });

    return Promise.all(
      assignments.map((a) => this.create({ userId: a.userId, ...data })),
    );
  }

  async notifyProjectManagers(projectId: string, data: {
    type: string;
    title: string;
    body: string;
    metadata?: Record<string, any>;
  }) {
    const projectMembers = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });

    const notifications = await Promise.all(
      projectMembers.map((member) =>
        this.create({
          userId: member.userId,
          ...data,
        }),
      ),
    );

    return notifications;
  }
}
