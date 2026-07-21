import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { EditHoursTransactionDto } from './dto/edit-hours-transaction.dto';
import { AppException, DuplicateResourceException } from '../../common/filters/app-exception';
import { PaginatedResult } from '../../common/interfaces/request.interface';
import { AuditService } from '../audit/audit.service';
import { EmailInvitationService } from '../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../auth/onboarding/onboarding.service';

@Injectable()
export class ClientService {
  private readonly logger = new Logger(ClientService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly emailInvitationService: EmailInvitationService,
    private readonly onboardingService: OnboardingService,
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
        ...(dto.portalBillingEnabled !== undefined && { portalBillingEnabled: dto.portalBillingEnabled }),
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
    params: { search?: string; page?: number; limit?: number; status?: string; withUsers?: boolean },
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

    // Si withUsers=true, incluir owner + sub-users del cliente para la vista
    // unificada de miembros (Feature #7: rediseno-vista-miembros-organizacion).
    const userInclude = params.withUsers
      ? {
          user: {
            select: {
              id: true, name: true, email: true,
              emailVerified: true, createdAt: true, image: true,
            },
          },
          users: {
            select: {
              id: true, name: true, email: true,
              emailVerified: true, createdAt: true, image: true,
            },
          },
        }
      : {
          user: { select: { email: true } },
        };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          _count: { select: { projects: true } },
          ...userInclude,
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
          where: { lifecycleStatus: 'ACTIVE' },
          select: { id: true, name: true, status: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        user: { select: { id: true, name: true, email: true } },
        users: { select: { id: true, name: true, email: true, emailVerified: true, createdAt: true } },
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
          ...(dto.portalBillingEnabled !== undefined && { portalBillingEnabled: dto.portalBillingEnabled }),
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

    // Decidir si enviar link de activacion (email) o temp password (UI fallback)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

    let activationMode: 'email-sent' | 'temp-password' = 'temp-password';
    if (!dto.password && updatedClient.userId) {
      const result = await this.onboardingService.createActivation({
        userId: updatedClient.userId,
        userName: dto.name,
        userEmail: dto.email.toLowerCase(),
        organizationName: org?.name ?? null,
      });
      activationMode = result.mode;
    }

    if (activationMode === 'temp-password') {
      this.emailInvitationService.sendClientUserEmail({
        email: dto.email.toLowerCase(),
        clientName: dto.name,
        organizationName: org?.name || 'la organizacion',
        temporaryPassword: tempPassword,
      }).catch((err) => {
        this.logger.error(`Failed to send client user email to ${dto.email}`, err);
      });
    }

    return {
      ...updatedClient,
      temporaryPassword: activationMode === 'temp-password' && !dto.password ? tempPassword : undefined,
      activationMode,
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

    // Decidir si enviar link de activacion (email) o temp password (UI fallback)
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

    let activationMode: 'email-sent' | 'temp-password' = 'temp-password';
    if (!dto.password) {
      const result = await this.onboardingService.createActivation({
        userId: user.id,
        userName: dto.name,
        userEmail: dto.email.toLowerCase(),
        organizationName: org?.name ?? null,
      });
      activationMode = result.mode;
    }

    if (activationMode === 'temp-password') {
      this.emailInvitationService.sendClientSubUserEmail({
        email: dto.email.toLowerCase(),
        userName: dto.name,
        clientName: client.name,
        organizationName: org?.name || 'la organizacion',
        temporaryPassword: tempPassword,
      }).catch((err) => {
        this.logger.error(`Failed to send client sub-user email to ${dto.email}`, err);
      });
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      temporaryPassword: activationMode === 'temp-password' && !dto.password ? tempPassword : undefined,
      activationMode,
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

  async resendActivation(orgId: string, clientId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, clientId },
      select: { id: true, name: true, email: true, emailVerified: true },
    });
    if (!user) {
      throw new AppException('Sub-usuario no encontrado', 'SUB_USER_NOT_FOUND', 404);
    }

    if (user.emailVerified) {
      throw new AppException(
        'Este usuario ya verificó su correo — no hace falta reenviar la activación',
        'USER_ALREADY_VERIFIED',
        409,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });

    // Invalidar links de activacion previos sin usar: al reenviar, solo el ultimo
    // email debe funcionar (evita confusion de "cual link uso" y reduce superficie).
    await this.prisma.userActivationToken.deleteMany({
      where: { userId, usedAt: null },
    });

    const result = await this.onboardingService.createActivation({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      organizationName: org?.name ?? null,
    });

    // createActivation cae a 'temp-password' si Resend esta caido o el envio fallo.
    // Para un reenvio explicito de admin eso es un fallo real: no devolver 200 mintiendo.
    if (result.mode !== 'email-sent') {
      throw new AppException(
        'No se pudo enviar el email de activación. El servicio de correo no está disponible en este momento.',
        'EMAIL_SERVICE_UNAVAILABLE',
        503,
      );
    }

    this.logger.log(`Activation email resent: ${user.email} (client: ${clientId})`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'client.subuser.activation_resent',
      resource: 'client',
      resourceId: clientId,
      newData: { userId: user.id, email: user.email },
    });

    return { message: 'Email de activación reenviado' };
  }

  // ── Horas contratadas ─────────────────────────────────

  async getHoursSummary(orgId: string, clientId: string, page = 1, limit = 20) {
    const client = await this.findById(orgId, clientId);
    const available = Math.max(client.contractedHours - client.usedHours - client.loanedHours, 0);

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const skip = (safePage - 1) * safeLimit;

    const where: Prisma.HoursTransactionWhereInput = { clientId, deletedAt: null };

    const [transactions, total, billableAggregate] = await this.prisma.$transaction([
      this.prisma.hoursTransaction.findMany({
        where,
        include: {
          task: { select: { id: true, title: true, type: true, project: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.hoursTransaction.count({ where }),
      this.prisma.hoursTransaction.aggregate({
        where: { ...where, type: { in: ['USAGE', 'LOAN'] }, priceAmount: { not: null } },
        _sum: { priceAmount: true },
      }),
    ]);

    const totalAmount = billableAggregate._sum.priceAmount
      ? parseFloat(billableAggregate._sum.priceAmount.toString())
      : 0;

    return {
      contractedHours: client.contractedHours,
      usedHours: client.usedHours,
      loanedHours: client.loanedHours,
      availableHours: available,
      developmentHourlyRate: client.developmentHourlyRate,
      supportHourlyRate: client.supportHourlyRate,
      currency: client.currency,
      totalAmount,
      transactions,
      transactionsTotal: total,
      page: safePage,
      limit: safeLimit,
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

    // R9 (#25): un movimiento ya facturado es inmutable. Reabrir el ciclo lo libera.
    // Guard check-then-act (§1.7 fallback aceptado): la ventana close-vs-delete del
    // mismo cliente es ínfima (ambas son acciones manuales del admin).
    if (tx.billedCycleId) {
      throw new AppException(
        'El movimiento ya fue facturado. Reabrí el ciclo para editarlo o eliminarlo.',
        'TRANSACTION_BILLED',
        409,
        { transactionId, billedCycleId: tx.billedCycleId },
      );
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

  async editHoursTransaction(
    orgId: string,
    clientId: string,
    transactionId: string,
    dto: EditHoursTransactionDto,
    editedById: string,
  ) {
    const client = await this.findById(orgId, clientId);

    const tx = await this.prisma.hoursTransaction.findFirst({
      where: { id: transactionId, clientId, deletedAt: null },
    });

    if (!tx) {
      throw new AppException(
        'Transaccion no encontrada o ya eliminada',
        'TRANSACTION_NOT_FOUND',
        404,
      );
    }

    // R9 (#25): un movimiento ya facturado es inmutable (horas/tarifa congeladas en el
    // snapshot del ciclo). Reabrir el ciclo lo libera. Guard check-then-act (§1.7 fallback).
    if (tx.billedCycleId) {
      throw new AppException(
        'El movimiento ya fue facturado. Reabrí el ciclo para editarlo.',
        'TRANSACTION_BILLED',
        409,
        { transactionId, billedCycleId: tx.billedCycleId },
      );
    }

    // Solo USAGE y LOAN son editables (afectan cupo del cliente).
    // PURCHASE/REFUND/INTERNAL no son consumo facturable y no se editan.
    if (tx.type !== 'USAGE' && tx.type !== 'LOAN') {
      throw new AppException(
        'Solo se pueden editar transacciones de uso (USAGE) o prestamo (LOAN)',
        'TRANSACTION_NOT_EDITABLE',
        400,
        { type: tx.type },
      );
    }

    if (dto.hours === undefined && dto.priceRate === undefined) {
      throw new AppException(
        'Debes enviar al menos un campo a editar (hours o priceRate)',
        'NOTHING_TO_EDIT',
        400,
      );
    }

    // Calcular nuevos valores. priceRate=null/0 limpia la tarifa.
    const newHours = dto.hours ?? tx.hours;
    const newRate: number | null =
      dto.priceRate !== undefined
        ? (dto.priceRate ?? 0) > 0
          ? Number(dto.priceRate)
          : null
        : tx.priceRate
        ? parseFloat(tx.priceRate.toString())
        : null;
    const newAmount =
      newRate !== null && newRate > 0
        ? parseFloat((newHours * newRate).toFixed(2))
        : null;
    // Currency: preservar la original si ya existia. Si la tx nunca tuvo
    // currency y ahora se agrega tarifa por primera vez, usar la moneda
    // actual del cliente.
    const newCurrency = tx.priceCurrency
      ? tx.priceCurrency
      : newAmount !== null
      ? client.currency
      : null;

    const delta = newHours - tx.hours;

    const oldData = {
      hours: tx.hours,
      priceAmount: tx.priceAmount ? parseFloat(tx.priceAmount.toString()) : null,
      priceRate: tx.priceRate ? parseFloat(tx.priceRate.toString()) : null,
      priceCurrency: tx.priceCurrency,
    };

    await this.prisma.$transaction(async (prisma) => {
      await prisma.hoursTransaction.update({
        where: { id: transactionId },
        data: {
          hours: newHours,
          priceAmount: newAmount,
          priceRate: newRate,
          priceCurrency: newCurrency,
        },
      });

      // Ajustar cupo del cliente segun el delta de horas. USAGE->usedHours,
      // LOAN->loanedHours. Si delta=0, no hace nada.
      if (delta !== 0) {
        const counterField: 'usedHours' | 'loanedHours' =
          tx.type === 'USAGE' ? 'usedHours' : 'loanedHours';
        await prisma.client.update({
          where: { id: clientId },
          data: { [counterField]: { increment: delta } },
        });
      }
    });

    const editedByUser = await this.prisma.user.findUnique({
      where: { id: editedById },
      select: { name: true, email: true },
    });

    this.logger.log(
      `Hours transaction ${transactionId} edited by ${editedByUser?.email} — ` +
        `hours: ${tx.hours} -> ${newHours}, rate: ${oldData.priceRate} -> ${newRate}, ` +
        `amount: ${oldData.priceAmount} -> ${newAmount}`,
    );

    await this.auditService.create({
      organizationId: orgId,
      action: 'client.hours.edited',
      resource: 'client',
      resourceId: clientId,
      oldData: { transactionId, type: tx.type, ...oldData },
      newData: {
        editedBy: editedByUser?.name,
        hours: newHours,
        priceAmount: newAmount,
        priceRate: newRate,
        priceCurrency: newCurrency,
      },
    });

    return { success: true, transactionId };
  }

  async recordHoursUsage(taskId: string, durationMinutes: number) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        type: true,
        billable: true,
        hourlyRate: true, // Override por tarea (Fase Precio Hora)
        project: {
          select: { id: true, name: true, clientId: true, organizationId: true },
        },
      },
    });

    if (!task?.project?.clientId) {
      this.logger.warn(`recordHoursUsage: Task ${taskId} — project ${task?.project?.id} (${task?.project?.name}) has no clientId. Cannot deduct hours.`);
      return;
    }

    // Fase B: ambos tipos (SUPPORT y PROJECT) descuentan del cupo del cliente.
    // El descuento se dispara desde HoursListener al recibir time_entry.confirmed.
    const clientId = task.project.clientId;
    const hours = parseFloat((durationMinutes / 60).toFixed(4));

    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return;

    // Tarea no facturable (trabajo interno): registramos la transaccion como INTERNAL
    // para trazabilidad, pero NO incrementamos usedHours ni guardamos precio.
    if (!task.billable) {
      await this.prisma.hoursTransaction.create({
        data: {
          clientId,
          type: 'INTERNAL',
          hours,
          taskId,
          note: `Tiempo interno (no facturable): ${task.title}`,
        },
      });
      this.logger.log(`Recorded ${hours}h INTERNAL (no descuenta) for task ${taskId}, client ${clientId}`);
      await this.auditService.create({
        organizationId: task.project.organizationId,
        action: 'client.hours.internal',
        resource: 'client',
        resourceId: clientId,
        newData: { hours, taskId, taskTitle: task.title },
      });
      return;
    }

    // Resolver tarifa snapshot (Fase Precio Hora):
    // Prioridad: task.hourlyRate (override) → client.{type}HourlyRate
    // Si no hay tarifa configurada, priceAmount queda null (transacción sin precio).
    const resolvedRate = (() => {
      if (task.hourlyRate) return parseFloat(task.hourlyRate.toString());
      if (task.type === 'SUPPORT' && client.supportHourlyRate) {
        return parseFloat(client.supportHourlyRate.toString());
      }
      if (task.type === 'PROJECT' && client.developmentHourlyRate) {
        return parseFloat(client.developmentHourlyRate.toString());
      }
      return null;
    })();

    const priceAmount = resolvedRate !== null
      ? parseFloat((hours * resolvedRate).toFixed(2))
      : null;

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
          priceAmount,
          priceRate: resolvedRate,
          priceCurrency: priceAmount !== null ? client.currency : null,
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

    this.logger.log(
      `Recorded ${hours}h ${isLoan ? '(loan)' : '(usage)'} for client ${clientId} ` +
      `[rate: ${resolvedRate ?? 'null'}, amount: ${priceAmount ?? 'null'} ${client.currency}]`,
    );

    await this.auditService.create({
      organizationId: task.project.organizationId,
      action: isLoan ? 'client.hours.loaned' : 'client.hours.consumed',
      resource: 'client',
      resourceId: clientId,
      newData: {
        hours,
        priceAmount,
        priceRate: resolvedRate,
        taskId,
        taskTitle: task.title,
        type: isLoan ? 'LOAN' : 'USAGE',
      },
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
