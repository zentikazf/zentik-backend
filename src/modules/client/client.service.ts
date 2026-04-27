import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { AppException, DuplicateResourceException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { AuditService } from '../audit/audit.service';
import { EmailInvitationService } from '../../infrastructure/email/email-invitation.service';

@Injectable()
export class ClientService {
  private readonly logger = new Logger(ClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly emailInvitationService: EmailInvitationService,
  ) {}

  async create(orgId: string, dto: CreateClientDto) {
    const client = await this.prisma.client.create({
      data: {
        organizationId: orgId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        notes: dto.notes,
        developmentHourlyRate: dto.developmentHourlyRate,
        supportHourlyRate: dto.supportHourlyRate,
        ...(dto.currency && { currency: dto.currency }),
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
          ...(dto.developmentHourlyRate !== undefined && { developmentHourlyRate: dto.developmentHourlyRate }),
          ...(dto.supportHourlyRate !== undefined && { supportHourlyRate: dto.supportHourlyRate }),
          ...(dto.currency !== undefined && { currency: dto.currency }),
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

    const tempPassword = dto.password || randomBytes(6).toString('base64url');
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const emailEnabled = this.emailInvitationService.isEnabled;

    const updatedClient = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: !emailEnabled,
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

    // Send client portal access email (fire & forget)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    this.emailInvitationService.sendClientUserEmail({
      email: dto.email.toLowerCase(),
      clientName: dto.name,
      organizationName: org?.name || 'la organizacion',
      temporaryPassword: tempPassword,
    }).catch((err) => {
      this.logger.error(`Failed to send client user email to ${dto.email}`, err);
    });

    return {
      ...updatedClient,
      temporaryPassword: dto.password ? undefined : tempPassword,
    };
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

    const tempPassword = dto.password || randomBytes(6).toString('base64url');
    const hashedPassword = await bcrypt.hash(tempPassword, 12);
    const emailEnabled = this.emailInvitationService.isEnabled;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: !emailEnabled,
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

    // Send client sub-user invitation email (fire & forget)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    this.emailInvitationService.sendClientSubUserEmail({
      email: dto.email.toLowerCase(),
      userName: dto.name,
      clientName: client.name,
      organizationName: org?.name || 'la organizacion',
      temporaryPassword: tempPassword,
    }).catch((err) => {
      this.logger.error(`Failed to send client sub-user email to ${dto.email}`, err);
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      temporaryPassword: dto.password ? undefined : tempPassword,
    };
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
      where: { clientId, deletedAt: null },
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
      developmentHourlyRate: client.developmentHourlyRate,
      supportHourlyRate: client.supportHourlyRate,
      currency: client.currency,
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

  async deleteHoursTransaction(orgId: string, clientId: string, transactionId: string, deletedById: string, reason: string) {
    await this.findById(orgId, clientId);

    const tx = await this.prisma.hoursTransaction.findFirst({
      where: { id: transactionId, clientId, deletedAt: null },
    });

    if (!tx) {
      throw new AppException('Transacción no encontrada', 'TRANSACTION_NOT_FOUND', 404);
    }

    await this.prisma.$transaction(async (prisma) => {
      // Soft-delete the transaction
      await prisma.hoursTransaction.update({
        where: { id: transactionId },
        data: { deletedAt: new Date(), deletedById, deleteReason: reason },
      });

      // Reverse the effect on client counters
      if (tx.type === 'PURCHASE') {
        await prisma.client.update({
          where: { id: clientId },
          data: { contractedHours: { decrement: tx.hours } },
        });
      } else if (tx.type === 'USAGE') {
        await prisma.client.update({
          where: { id: clientId },
          data: { usedHours: { decrement: tx.hours } },
        });
      } else if (tx.type === 'LOAN') {
        await prisma.client.update({
          where: { id: clientId },
          data: { loanedHours: { decrement: tx.hours } },
        });
      } else if (tx.type === 'REFUND') {
        await prisma.client.update({
          where: { id: clientId },
          data: { contractedHours: { decrement: tx.hours } },
        });
      }
    });

    const deletedByUser = await this.prisma.user.findUnique({
      where: { id: deletedById },
      select: { name: true, email: true },
    });

    this.logger.log(`Hours transaction ${transactionId} deleted by ${deletedByUser?.email} — reason: ${reason}`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.deleted',
      resource: 'client',
      resourceId: clientId,
      oldData: { transactionId, type: tx.type, hours: tx.hours, note: tx.note },
      newData: { deletedBy: deletedByUser?.name, reason },
    });
  }

  async recordHoursUsage(taskId: string, durationMinutes: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        type: true,
        project: {
          select: { id: true, name: true, clientId: true, organizationId: true },
        },
      },
    });

    if (!task?.project?.clientId) {
      this.logger.warn(`recordHoursUsage: Task ${taskId} — project ${task?.project?.id} (${task?.project?.name}) has no clientId. Cannot deduct hours.`);
      return;
    }

    if (task.type !== 'SUPPORT') {
      this.logger.log(`recordHoursUsage: Task ${taskId} is type ${task.type}, skipping (only SUPPORT deducts)`);
      return;
    }

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

  /**
   * Find SUPPORT tasks in DONE status that were never recorded as hour usage
   * and process them. Fixes tasks that were completed before the event emit was added.
   */
  async syncMissedHours(orgId: string, clientId: string) {
    const client = await this.findById(orgId, clientId);

    // Find all DONE SUPPORT tasks for this client's projects that don't have a corresponding USAGE/LOAN transaction
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'DONE',
        type: 'SUPPORT',
        project: {
          clientId,
          organizationId: orgId,
        },
      },
      select: {
        id: true,
        title: true,
        estimatedHours: true,
        createdAt: true,
      },
    });

    const existingTxns = await this.prisma.hoursTransaction.findMany({
      where: {
        clientId,
        type: { in: ['USAGE', 'LOAN'] },
        taskId: { in: tasks.map((t) => t.id) },
      },
      select: { taskId: true },
    });

    const processedTaskIds = new Set(existingTxns.map((t) => t.taskId));
    const missed = tasks.filter((t) => !processedTaskIds.has(t.id));

    let synced = 0;
    for (const task of missed) {
      const minutes = task.estimatedHours
        ? task.estimatedHours * 60
        : Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);

      if (minutes > 0) {
        await this.recordHoursUsage(task.id, minutes);
        synced++;
        this.logger.log(`Synced missed hours: ${(minutes / 60).toFixed(2)}h for task ${task.id} (${task.title})`);
      }
    }

    return { total: tasks.length, alreadyProcessed: processedTaskIds.size, synced };
  }

  /**
   * Get available hours for a client linked to a project.
   * Returns null if the project has no client.
   */
  async getAvailableHoursByProject(projectId: string): Promise<{ clientId: string; clientName: string; availableHours: number; contractedHours: number; usedHours: number; loanedHours: number } | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { clientId: true },
    });
    if (!project?.clientId) return null;

    const client = await this.prisma.client.findUnique({
      where: { id: project.clientId },
      select: { id: true, name: true, contractedHours: true, usedHours: true, loanedHours: true },
    });
    if (!client) return null;

    return {
      clientId: client.id,
      clientName: client.name,
      availableHours: Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0),
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
    };
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
