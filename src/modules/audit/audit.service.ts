import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface CreateAuditLogParams {
  organizationId: string;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  oldData?: Record<string, unknown>;
  newData?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateAuditLogParams) {
    try {
      const log = await this.prisma.auditLog.create({
        data: {
          organizationId: params.organizationId,
          userId: params.userId || null,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId || null,
          oldData: params.oldData ? (params.oldData as any) : undefined,
          newData: params.newData ? (params.newData as any) : undefined,
          ipAddress: params.ipAddress || null,
          userAgent: params.userAgent || null,
        },
      });

      this.logger.debug(
        `Audit log created: ${params.action} on ${params.resource}:${params.resourceId}`,
      );
      return log;
    } catch (error) {
      this.logger.error('Failed to create audit log', error);
      // Don't throw - audit logging should not break the main flow
    }
  }

  async listByOrganization(orgId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { organizationId: orgId },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where: { organizationId: orgId } }),
    ]);

    return { data, total, page, limit };
  }

  async listByProject(projectId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          OR: [
            { resource: 'project', resourceId: projectId },
            { resource: 'task', newData: { path: ['projectId'], equals: projectId } },
          ],
        },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({
        where: {
          OR: [
            { resource: 'project', resourceId: projectId },
            { resource: 'task', newData: { path: ['projectId'], equals: projectId } },
          ],
        },
      }),
    ]);

    return { data, total, page, limit };
  }

  async listByTask(taskId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { resource: 'task', resourceId: taskId },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({
        where: { resource: 'task', resourceId: taskId },
      }),
    ]);

    return { data, total, page, limit };
  }
}
