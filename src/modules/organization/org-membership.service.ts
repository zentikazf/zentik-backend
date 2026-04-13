import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { CreateMemberDto } from './dto';
import {
  OrganizationNotFoundException,
  AppException,
} from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { OrganizationService } from './organization.service';
import { EmailInvitationService } from '../../infrastructure/email/email-invitation.service';

@Injectable()
export class OrgMembershipService {
  private readonly logger = new Logger(OrgMembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly organizationService: OrganizationService,
    private readonly emailInvitationService: EmailInvitationService,
  ) {}

  async listMembers(orgId: string) {
    await this.organizationService.findById(orgId);

    return this.prisma.organizationMember.findMany({
      where: { organizationId: orgId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async updateMemberRole(orgId: string, memberId: string, roleId: string) {
    await this.organizationService.findById(orgId);

    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
    });

    if (!member) {
      throw new OrganizationNotFoundException(orgId);
    }

    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId: orgId },
    });

    if (!role) {
      throw new OrganizationNotFoundException(orgId);
    }

    return this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { roleId },
      include: {
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
  }

  async removeMember(orgId: string, memberId: string) {
    await this.organizationService.findById(orgId);

    const member = await this.prisma.organizationMember.findFirst({
      where: { id: memberId, organizationId: orgId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { name: true } },
      },
    });

    if (!member) {
      throw new OrganizationNotFoundException(orgId);
    }

    await this.prisma.organizationMember.delete({
      where: { id: memberId },
    });

    const remainingMemberships = await this.prisma.organizationMember.count({
      where: { userId: member.userId },
    });

    let userDeleted = false;
    if (remainingMemberships === 0) {
      await this.prisma.$transaction([
        this.prisma.session.deleteMany({ where: { userId: member.userId } }),
        this.prisma.account.deleteMany({ where: { userId: member.userId } }),
        this.prisma.notification.deleteMany({ where: { userId: member.userId } }),
        this.prisma.user.delete({ where: { id: member.userId } }),
      ]);
      userDeleted = true;
      this.logger.log(`Orphaned user ${member.user.email} deleted after removal from org ${orgId}`);
    }

    this.eventEmitter.emit('organization.member.removed', {
      ...domainEvent('organization.member.removed', 'organization', orgId, orgId, member.userId, {
        userName: member.user.name,
        userEmail: member.user.email,
        roleName: member.role.name,
      }),
      organizationId: orgId,
      userId: member.userId,
    });

    return { deleted: true, userDeleted };
  }

  async ensureSaaSRoles(orgId: string) {
    await this.organizationService.findById(orgId);

    const existingRoles = await this.prisma.role.findMany({
      where: { organizationId: orgId },
      select: { name: true },
    });
    const existingNames = new Set(existingRoles.map((r) => r.name));

    const defaultRoles = [
      { name: 'Owner', description: 'Propietario con acceso completo', isSystem: true, isDefault: false },
      { name: 'Product Owner', description: 'Responsable del producto y backlog', isSystem: false, isDefault: false },
      { name: 'Project Manager', description: 'Gestión de proyectos y equipo', isSystem: false, isDefault: false },
      { name: 'Tech Lead', description: 'Líder técnico del equipo', isSystem: false, isDefault: false },
      { name: 'Developer', description: 'Desarrollador de software', isSystem: false, isDefault: true },
      { name: 'QA Engineer', description: 'Ingeniero de calidad y testing', isSystem: false, isDefault: false },
      { name: 'Designer', description: 'Diseñador UI/UX', isSystem: false, isDefault: false },
      { name: 'DevOps', description: 'Infraestructura y despliegues', isSystem: false, isDefault: false },
      { name: 'Soporte', description: 'Soporte al cliente', isSystem: false, isDefault: false },
    ];

    const missing = defaultRoles.filter((r) => !existingNames.has(r.name));
    if (missing.length === 0) {
      return { created: [], existing: defaultRoles.map((r) => r.name) };
    }

    const suggestions: Record<string, string[]> = {
      'Owner': ['*:*'],
      'Product Owner': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'read:members', 'read:billing', 'manage:chat'],
      'Project Manager': ['manage:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:members', 'manage:time-entries', 'read:billing', 'manage:chat', 'read:audit'],
      'Tech Lead': ['read:projects', 'manage:tasks', 'manage:sprints', 'manage:boards', 'manage:time-entries', 'read:members', 'manage:chat'],
      'Developer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'QA Engineer': ['read:projects', 'manage:tasks', 'read:sprints', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'Designer': ['read:projects', 'manage:tasks', 'read:boards', 'manage:time-entries', 'manage:chat'],
      'DevOps': ['read:projects', 'read:tasks', 'read:sprints', 'manage:time-entries', 'manage:chat'],
      'Soporte': ['read:projects', 'read:tasks', 'manage:time-entries', 'manage:chat'],
    };

    const allPermissions = await this.prisma.permission.findMany({ take: 500 });
    const permMap = new Map(allPermissions.map((p) => [`${p.action}:${p.resource}`, p.id]));

    const createdNames: string[] = [];
    for (const roleDef of missing) {
      const role = await this.prisma.role.create({
        data: {
          organizationId: orgId,
          name: roleDef.name,
          description: roleDef.description,
          isSystem: roleDef.isSystem,
          isDefault: roleDef.isDefault,
        },
      });

      const permKeys = suggestions[roleDef.name] || [];
      const permIds = permKeys.map((k) => permMap.get(k)).filter(Boolean) as string[];
      if (permIds.length > 0) {
        await this.prisma.rolePermission.createMany({
          data: permIds.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }

      createdNames.push(roleDef.name);
    }

    this.logger.log(`Backfilled ${createdNames.length} roles for org: ${orgId}`);
    return {
      created: createdNames,
      existing: [...existingNames],
    };
  }

  async createMember(orgId: string, dto: CreateMemberDto, createdById: string) {
    await this.organizationService.findById(orgId);

    const role = await this.prisma.role.findFirst({
      where: { id: dto.roleId, organizationId: orgId },
    });
    if (!role) {
      throw new AppException('El rol especificado no existe en esta organización', 'ROLE_NOT_FOUND', 404);
    }

    const email = dto.email.toLowerCase();

    let user = await this.prisma.user.findUnique({ where: { email } });

    const tempPassword = dto.password || randomBytes(6).toString('base64url');
    let isNewUser = false;

    if (user) {
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
      });
      if (existingMember) {
        throw new AppException('Este usuario ya es miembro de la organización', 'ALREADY_MEMBER', 409);
      }

      const hashedPassword = await bcrypt.hash(tempPassword, 12);
      await this.prisma.$transaction([
        this.prisma.account.updateMany({
          where: { userId: user.id, providerId: 'credential' },
          data: { password: hashedPassword },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: { mustChangePassword: true },
        }),
      ]);
    } else {
      isNewUser = true;
      const hashedPassword = await bcrypt.hash(tempPassword, 12);
      const emailEnabled = this.emailInvitationService.isEnabled;
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            name: dto.name,
            emailVerified: !emailEnabled,
            onboardingCompleted: true,
            mustChangePassword: true,
          },
        });
        await tx.account.create({
          data: {
            userId: newUser.id,
            accountId: newUser.id,
            providerId: 'credential',
            password: hashedPassword,
          },
        });
        return newUser;
      });
    }

    const member = await this.prisma.organizationMember.create({
      data: {
        organizationId: orgId,
        userId: user.id,
        roleId: dto.roleId,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, name: true } },
      },
    });

    this.logger.log(`Member created: ${user.email} in org ${orgId} by ${createdById}`);
    this.eventEmitter.emit('organization.member.joined', {
      ...domainEvent('organization.member.joined', 'organization', orgId, orgId, createdById, {
        userName: user.name,
        userEmail: user.email,
        roleName: role.name,
      }),
      organizationId: orgId,
      userId: user.id,
    });

    // Send team invitation email (fire & forget)
    const inviter = await this.prisma.user.findUnique({ where: { id: createdById }, select: { name: true } });
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    this.emailInvitationService.sendTeamInviteEmail({
      email: user.email,
      memberName: dto.name,
      invitedByName: inviter?.name || 'El equipo',
      organizationName: org?.name || 'la organizacion',
      roleName: role.name,
      temporaryPassword: tempPassword,
    }).catch((err) => {
      this.logger.error(`Failed to send team invite email to ${user.email}`, err);
    });

    return {
      member,
      temporaryPassword: dto.password ? undefined : tempPassword,
      isNewUser,
    };
  }
}
