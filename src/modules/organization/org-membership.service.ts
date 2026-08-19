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
import { OnboardingService } from '../auth/onboarding/onboarding.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class OrgMembershipService {
  private readonly logger = new Logger(OrgMembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly organizationService: OrganizationService,
    private readonly emailInvitationService: EmailInvitationService,
    private readonly onboardingService: OnboardingService,
    private readonly auditService: AuditService,
  ) {}

  async listMembers(orgId: string, excludeRole?: string) {
    await this.organizationService.findById(orgId);

    // excludeRole soporta CSV: ?excludeRole=Cliente,Externo
    const excluded = excludeRole?.split(',').map((r) => r.trim()).filter(Boolean) ?? [];

    return this.prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        ...(excluded.length > 0 && { role: { name: { notIn: excluded } } }),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
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

    // Resolver org para nombre del header en email
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

    // Si el admin paso un password explicito (dto.password), respeta el flujo
    // tradicional y NO usa link de activacion (asume control manual).
    // Si NO paso password Y email service esta disponible, usar link de activacion.
    let activationMode: 'email-sent' | 'temp-password' = 'temp-password';
    if (!dto.password && this.onboardingService) {
      const result = await this.onboardingService.createActivation({
        userId: user.id,
        userName: dto.name,
        userEmail: user.email,
        organizationName: org?.name ?? null,
      });
      activationMode = result.mode;
    }

    // Si NO se envio link de activacion, mandar el email tradicional con temp password
    if (activationMode === 'temp-password') {
      const inviter = await this.prisma.user.findUnique({ where: { id: createdById }, select: { name: true } });
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
    }

    return {
      member,
      // Solo expone tempPassword en UI cuando el link de activacion NO se envio
      temporaryPassword: activationMode === 'temp-password' && !dto.password ? tempPassword : undefined,
      activationMode,
      isNewUser,
    };
  }

  /**
   * #59 — Reenvia el email de activacion a un miembro del equipo de la organizacion.
   *
   * Espejo exacto de `ClientService.resendActivation` (el de sub-usuarios de cliente).
   * Existe porque el boton de /settings/members llamaba a `POST /auth/resend-verification`,
   * que IGNORA el body y usa `@CurrentUser()`: el mail le llegaba al admin que apretaba el
   * boton, no al miembro — y como respondia 200, la UI mostraba exito y encima nombraba la
   * casilla del miembro. Mentia sobre el resultado Y sobre el destinatario.
   */
  async resendActivation(orgId: string, userId: string) {
    // Este `where` ES el guard de verdad: el AuthGuard solo garantiza que hay sesion, no
    // que ESE usuario pueda tocar a ESE miembro (y el IDOR de :orgId sigue abierto).
    // 404 y no 403 a proposito: un 403 revelaria que el id existe en otra organizacion.
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId: orgId, userId },
      select: {
        user: { select: { id: true, name: true, email: true, emailVerified: true } },
      },
    });
    if (!membership) {
      throw new AppException('Miembro no encontrado', 'MEMBER_NOT_FOUND', 404);
    }

    const user = membership.user;

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

    // Invalidar links de activacion previos sin usar: al reenviar, solo el ultimo email
    // debe funcionar (evita la confusion de "cual link uso" y reduce superficie).
    await this.prisma.userActivationToken.deleteMany({
      where: { userId, usedAt: null },
    });

    const result = await this.onboardingService.createActivation({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      organizationName: org?.name ?? null,
    });

    // createActivation cae a 'temp-password' si el email service esta caido o el envio
    // fallo. Para un reenvio explicito de admin eso es un fallo real: no devolver 200
    // mintiendo.
    if (result.mode !== 'email-sent') {
      throw new AppException(
        'No se pudo enviar el email de activación. El servicio de correo no está disponible en este momento.',
        'EMAIL_SERVICE_UNAVAILABLE',
        503,
      );
    }

    this.logger.log(`Activation email resent: ${user.email} (org: ${orgId})`);
    await this.auditService.create({
      organizationId: orgId,
      action: 'organization.member.activation_resent',
      resource: 'organization',
      resourceId: orgId,
      newData: { userId: user.id, email: user.email },
    });

    return { message: 'Email de activación reenviado' };
  }
}
