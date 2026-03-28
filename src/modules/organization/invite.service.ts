import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { CreateInviteDto } from './dto';
import {
  OrganizationNotFoundException,
  AppException,
} from '../../common/filters/app-exception';
import { randomUUID } from 'crypto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createInvite(orgId: string, dto: CreateInviteDto) {
    // Validate organization exists
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!organization) {
      throw new OrganizationNotFoundException(orgId);
    }

    // Validate the role belongs to this organization
    const role = await this.prisma.role.findFirst({
      where: { id: dto.roleId, organizationId: orgId },
    });

    if (!role) {
      throw new AppException(
        'El rol especificado no existe en esta organizacion',
        'ROLE_NOT_FOUND',
        404,
        { roleId: dto.roleId, orgId },
      );
    }

    const code = randomUUID().replace(/-/g, '').substring(0, 16);

    const invite = await this.prisma.inviteLink.create({
      data: {
        organizationId: orgId,
        code,
        roleId: dto.roleId,
        maxUses: dto.maxUses ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });

    this.logger.log(`Invite link created for org: ${orgId}, code: ${code}`);

    return invite;
  }

  async listInvites(orgId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });

    if (!organization) {
      throw new OrganizationNotFoundException(orgId);
    }

    return this.prisma.inviteLink.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async joinByCode(code: string, userId: string) {
    const invite = await this.prisma.inviteLink.findUnique({
      where: { code },
    });

    if (!invite || !invite.isActive) {
      throw new AppException(
        'El enlace de invitacion no es valido o ha sido desactivado',
        'INVITE_INVALID',
        400,
      );
    }

    // Check expiration
    if (invite.expiresAt && new Date() > invite.expiresAt) {
      throw new AppException(
        'El enlace de invitacion ha expirado',
        'INVITE_EXPIRED',
        400,
      );
    }

    // Check max uses
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      throw new AppException(
        'El enlace de invitacion ha alcanzado el numero maximo de usos',
        'INVITE_MAX_USES_REACHED',
        400,
      );
    }

    // Check if user is already a member
    const existingMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invite.organizationId,
          userId,
        },
      },
    });

    if (existingMember) {
      throw new AppException(
        'Ya eres miembro de esta organizacion',
        'ALREADY_MEMBER',
        409,
      );
    }

    const member = await this.prisma.$transaction(async (tx) => {
      // Create membership
      const newMember = await tx.organizationMember.create({
        data: {
          organizationId: invite.organizationId,
          userId,
          roleId: invite.roleId,
        },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          role: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // Increment used count
      await tx.inviteLink.update({
        where: { id: invite.id },
        data: { usedCount: { increment: 1 } },
      });

      return newMember;
    });

    this.logger.log(
      `User ${userId} joined org ${invite.organizationId} via invite code: ${code}`,
    );
    this.eventEmitter.emit('organization.member.joined', {
      ...domainEvent('organization.member.joined', 'organization', invite.organizationId, invite.organizationId, userId, {
        userName: (member as any).user?.name ?? '',
        userEmail: (member as any).user?.email ?? '',
        roleName: member.role.name,
      }),
      organizationId: invite.organizationId,
      userId,
    });

    return member;
  }
}
