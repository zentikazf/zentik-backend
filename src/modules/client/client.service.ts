import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { AppException, DuplicateResourceException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ClientService {
  private readonly logger = new Logger(ClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(orgId: string, dto: CreateClientDto) {
    const client = await this.prisma.client.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        notes: dto.notes,
      },
    });

    this.logger.log(`Client created: ${client.id} in org: ${orgId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.created',
      resource: 'client',
      resourceId: client.id,
      newData: { name: dto.name, email: dto.email },
    });
    return client;
  }

  async findAll(
    orgId: string,
    params: { search?: string; page?: number; limit?: number; status?: string },
  ): Promise<PaginatedResult<any>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: Prisma.ClientWhereInput = { organizationId: orgId };

    if (params.status) {
      where.status = params.status as any;
    }

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          _count: { select: { projects: true } },
          user: { select: { email: true } },
        },
      }),
      this.prisma.client.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findById(orgId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId },
      include: {
        _count: { select: { projects: true, users: true } },
        projects: {
          select: { id: true, name: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        user: { select: { id: true, name: true, email: true } },
        users: { select: { id: true, name: true, email: true, createdAt: true } },
      },
    });

    if (!client) {
      throw new AppException('El cliente no existe', 'CLIENT_NOT_FOUND', 404, { clientId });
    }

    return client;
  }

  async update(orgId: string, clientId: string, dto: UpdateClientDto) {
    const existing = await this.findById(orgId, clientId);

    const client = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id: clientId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      // Sync User.name if client has a linked user account
      if (dto.name !== undefined && existing.userId) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { name: dto.name },
        });
      }

      return updated;
    });

    this.logger.log(`Client updated: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.updated',
      resource: 'client',
      resourceId: clientId,
      oldData: { name: existing.name, email: existing.email },
      newData: { name: dto.name, email: dto.email },
    });
    return client;
  }

  async changeStatus(orgId: string, clientId: string, newStatus: 'ACTIVE' | 'DISABLED' | 'ARCHIVED') {
    const client = await this.findById(orgId, clientId);

    await this.prisma.$transaction(async (tx) => {
      // Update client status
      await tx.client.update({
        where: { id: clientId },
        data: { status: newStatus },
      });

      if (newStatus === 'DISABLED' || newStatus === 'ARCHIVED') {
        // Collect all user IDs linked to this client
        const userIds: string[] = [];
        if (client.userId) userIds.push(client.userId);

        const subUsers = await tx.user.findMany({
          where: { clientId },
          select: { id: true },
        });
        subUsers.forEach((u) => userIds.push(u.id));

        // Invalidate all sessions immediately
        if (userIds.length > 0) {
          await tx.session.deleteMany({ where: { userId: { in: userIds } } });
        }

        // Close open tickets
        await tx.ticket.updateMany({
          where: {
            clientId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
          data: { status: 'CLOSED', adminNotes: 'Cliente deshabilitado' },
        });
      }
    });

    const actionMap = {
      ACTIVE: 'client.reactivated',
      DISABLED: 'client.disabled',
      ARCHIVED: 'client.archived',
    };

    this.logger.log(`Client ${newStatus}: ${clientId} in org: ${orgId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: actionMap[newStatus],
      resource: 'client',
      resourceId: clientId,
      newData: { status: newStatus, name: client.name },
    });
  }

  async createClientUser(orgId: string, clientId: string, dto: CreateClientUserDto) {
    const client = await this.findById(orgId, clientId);

    if (client.userId) {
      throw new AppException('Este cliente ya tiene un usuario asignado', 'CLIENT_USER_EXISTS', 400);
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    // Find or create "Cliente" role for the organization
    const clienteRole = await this.ensureClienteRole(orgId);

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const updatedClient = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: true,
        },
      });

      await tx.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: user.id,
          roleId: clienteRole.id,
        },
      });

      const updated = await tx.client.update({
        where: { id: clientId },
        data: { userId: user.id },
        include: {
          user: { select: { id: true, email: true, name: true } },
          _count: { select: { projects: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Client user created: ${updatedClient.userId} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.user.created',
      resource: 'client',
      resourceId: clientId,
      newData: { email: dto.email, name: dto.name, userId: updatedClient.userId },
    });
    return updatedClient;
  }

  // ── Portal toggle ──────────────────────────────────────

  async togglePortal(orgId: string, clientId: string, enabled: boolean) {
    await this.findById(orgId, clientId);
    const updated = await this.prisma.client.update({
      where: { id: clientId },
      data: { portalEnabled: enabled },
    });
    this.logger.log(`Portal ${enabled ? 'enabled' : 'disabled'} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.portal.toggled',
      resource: 'client',
      resourceId: clientId,
      newData: { portalEnabled: enabled },
    });
    return updated;
  }

  // ── Sub-usuarios ──────────────────────────────────────

  async createSubUser(orgId: string, clientId: string, dto: CreateClientUserDto) {
    const client = await this.findById(orgId, clientId);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    const clienteRole = await this.ensureClienteRole(orgId);

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: true,
          mustChangePassword: true,
          clientId: client.id,
        },
      });

      await tx.account.create({
        data: {
          userId: created.id,
          accountId: created.id,
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId: orgId,
          userId: created.id,
          roleId: clienteRole.id,
        },
      });

      return created;
    });

    this.logger.log(`Sub-user created: ${user.id} for client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.created',
      resource: 'client',
      resourceId: clientId,
      newData: { email: dto.email, name: dto.name, userId: user.id },
    });
    return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
  }

  async listSubUsers(clientId: string) {
    return this.prisma.user.findMany({
      where: { clientId },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteSubUser(orgId: string, clientId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, clientId },
    });
    if (!user) {
      throw new AppException('Sub-usuario no encontrado', 'SUB_USER_NOT_FOUND', 404);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.deleteMany({
        where: { userId, organizationId: orgId },
      });
      await tx.account.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });

    this.logger.log(`Sub-user deleted: ${userId} from client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.deleted',
      resource: 'client',
      resourceId: clientId,
      oldData: { userId, name: user.name, email: user.email },
    });
  }

  // ── Horas contratadas ─────────────────────────────────

  async getHoursSummary(orgId: string, clientId: string) {
    const client = await this.findById(orgId, clientId);
    const available = Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0);

    const transactions = await this.prisma.hoursTransaction.findMany({
      where: { clientId },
      include: {
        task: { select: { id: true, title: true, project: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
      availableHours: available,
      transactions,
    };
  }

  async addHours(orgId: string, clientId: string, hours: number, note?: string) {
    const client = await this.findById(orgId, clientId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.hoursTransaction.create({
        data: {
          clientId,
          type: 'PURCHASE',
          hours,
          note: note || `Carga de ${hours} horas`,
        },
      });

      return tx.client.update({
        where: { id: clientId },
        data: { contractedHours: { increment: hours } },
      });
    });

    this.logger.log(`Added ${hours} hours to client: ${clientId}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.purchased',
      resource: 'client',
      resourceId: clientId,
      newData: { hours, note, totalContracted: updated.contractedHours },
    });
    return updated;
  }

  async recordHoursUsage(taskId: string, durationMinutes: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        project: {
          select: { clientId: true, organizationId: true },
        },
      },
    });

    if (!task?.project?.clientId) return;

    const clientId = task.project.clientId;
    const hours = parseFloat((durationMinutes / 60).toFixed(4));

    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return;

    const available = client.contractedHours - client.usedHours;
    const isLoan = available <= 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.hoursTransaction.create({
        data: {
          clientId,
          type: isLoan ? 'LOAN' : 'USAGE',
          hours,
          taskId,
          note: `Tiempo registrado en: ${task.title}`,
        },
      });

      if (isLoan) {
        await tx.client.update({
          where: { id: clientId },
          data: { loanedHours: { increment: hours } },
        });
      } else {
        await tx.client.update({
          where: { id: clientId },
          data: { usedHours: { increment: hours } },
        });
      }
    });

    this.logger.log(`Recorded ${hours}h ${isLoan ? '(loan)' : '(usage)'} for client: ${clientId}, task: ${taskId}`);
    await this.auditService.create({
      organizationId: task.project.organizationId,
      action: isLoan ? 'client.hours.loaned' : 'client.hours.consumed',
      resource: 'client',
      resourceId: clientId,
      newData: { hours, taskId, taskTitle: task.title, type: isLoan ? 'LOAN' : 'USAGE' },
    });
  }

  // ── Helpers ──────────────────────────────────────────

  /**
   * Find or create the "Cliente" role for an organization and ensure
   * it always has the required permissions (read:projects, read:tasks, read:chat, write:chat).
   */
  async ensureClienteRole(orgId: string) {
    let clienteRole = await this.prisma.role.findFirst({
      where: { organizationId: orgId, name: 'Cliente' },
    });

    if (!clienteRole) {
      clienteRole = await this.prisma.role.create({
        data: {
          organizationId: orgId,
          name: 'Cliente',
          description: 'Cliente externo con acceso al portal',
          isSystem: true,
          isDefault: false,
        },
      });
      this.logger.log(`Created "Cliente" role for org: ${orgId}`);
    }

    // Ensure chat permissions exist globally
    await this.prisma.permission.upsert({
      where: { action_resource: { action: 'read', resource: 'chat' } },
      update: {},
      create: { action: 'read', resource: 'chat', description: 'Read chat' },
    });
    await this.prisma.permission.upsert({
      where: { action_resource: { action: 'write', resource: 'chat' } },
      update: {},
      create: { action: 'write', resource: 'chat', description: 'Write chat' },
    });

    // Ensure all required permissions are assigned to the role
    const requiredPermissions = await this.prisma.permission.findMany({
      where: {
        OR: [
          { action: 'read', resource: 'projects' },
          { action: 'read', resource: 'tasks' },
          { action: 'read', resource: 'chat' },
          { action: 'write', resource: 'chat' },
        ],
      },
    });

    if (requiredPermissions.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: requiredPermissions.map((p) => ({
          roleId: clienteRole.id,
          permissionId: p.id,
        })),
        skipDuplicates: true,
      });
    }

    return clienteRole;
  }
}
