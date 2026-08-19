import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { OrgMembershipService } from '../org-membership.service';
import { OrganizationController } from '../organization.controller';
import { OrganizationService } from '../organization.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { AppException } from '../../../common/filters/app-exception';

/**
 * Feature #59 — reenvio de activacion para miembros del equipo de la organizacion.
 *
 * Prisma MOCKEADO — no toca DB. Cubre R5.2: miembro de otra org → 404 (no 403, para no
 * revelar existencia), ya verificado → 409, los tokens viejos se borran ANTES de emitir
 * el nuevo, `createActivation` en modo `temp-password` → 503 (no un 200 mintiendo), el
 * happy path audita, y la ruta exige `manage:members`.
 */
describe('OrgMembershipService.resendActivation (#59)', () => {
  let service: OrgMembershipService;
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let onboarding: DeepMockProxy<OnboardingService>;

  const ORG = 'org-1';
  const USER = 'user-miembro-1';

  const MEMBER = {
    user: {
      id: USER,
      name: 'Ana Miembro',
      email: 'ana@zentikk.test',
      emailVerified: false,
    },
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    onboarding = mockDeep<OnboardingService>();
    service = new OrgMembershipService(
      prisma,
      mockDeep<EventEmitter2>(),
      mockDeep<OrganizationService>(),
      mockDeep<EmailInvitationService>(),
      onboarding,
      audit,
    );

    prisma.organizationMember.findFirst.mockResolvedValue(MEMBER as never);
    prisma.organization.findUnique.mockResolvedValue({ name: 'Zentikk' } as never);
    prisma.userActivationToken.deleteMany.mockResolvedValue({ count: 1 } as never);
    onboarding.createActivation.mockResolvedValue({ mode: 'email-sent' } as never);
  });

  // ── R2.1: la pertenencia es el guard de verdad ────────────────────────────
  describe('pertenencia a la organizacion (R2.1)', () => {
    it('miembro de OTRA org → 404 MEMBER_NOT_FOUND, no 403', async () => {
      prisma.organizationMember.findFirst.mockResolvedValue(null as never);

      const err = await service.resendActivation(ORG, USER).catch((e) => e);

      expect(err).toBeInstanceOf(AppException);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('MEMBER_NOT_FOUND');
    });

    it('el where filtra por organizationId Y userId (es el candado, no el decorador)', async () => {
      await service.resendActivation(ORG, USER);

      const where = prisma.organizationMember.findFirst.mock.calls[0][0]!.where as Record<
        string,
        unknown
      >;
      expect(where.organizationId).toBe(ORG);
      expect(where.userId).toBe(USER);
    });

    it('si no pertenece, NO borra tokens ni emite activacion', async () => {
      prisma.organizationMember.findFirst.mockResolvedValue(null as never);

      await service.resendActivation(ORG, USER).catch(() => undefined);

      expect(prisma.userActivationToken.deleteMany).not.toHaveBeenCalled();
      expect(onboarding.createActivation).not.toHaveBeenCalled();
    });
  });

  // ── R2.2: ya verificado ───────────────────────────────────────────────────
  describe('usuario ya verificado (R2.2)', () => {
    beforeEach(() => {
      prisma.organizationMember.findFirst.mockResolvedValue({
        user: { ...MEMBER.user, emailVerified: true },
      } as never);
    });

    it('→ 409 USER_ALREADY_VERIFIED', async () => {
      const err = await service.resendActivation(ORG, USER).catch((e) => e);

      expect(err).toBeInstanceOf(AppException);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('USER_ALREADY_VERIFIED');
    });

    it('no se puede usar el boton como generador de mails: no emite nada', async () => {
      await service.resendActivation(ORG, USER).catch(() => undefined);

      expect(prisma.userActivationToken.deleteMany).not.toHaveBeenCalled();
      expect(onboarding.createActivation).not.toHaveBeenCalled();
      expect(audit.create).not.toHaveBeenCalled();
    });
  });

  // ── R2.3: solo el ultimo link vive ────────────────────────────────────────
  describe('invalidacion de los links previos (R2.3)', () => {
    it('borra los tokens sin usar de ese userId', async () => {
      await service.resendActivation(ORG, USER);

      expect(prisma.userActivationToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER, usedAt: null },
      });
    });

    it('los borra ANTES de crear el nuevo (al reves, el nuevo se borraria solo)', async () => {
      await service.resendActivation(ORG, USER);

      const borrado = prisma.userActivationToken.deleteMany.mock.invocationCallOrder[0];
      const creacion = onboarding.createActivation.mock.invocationCallOrder[0];
      expect(borrado).toBeLessThan(creacion);
    });
  });

  // ── R2.4 / R2.6: happy path ───────────────────────────────────────────────
  describe('happy path (R2.4, R2.6)', () => {
    it('emite la activacion con los datos del MIEMBRO, no los del admin', async () => {
      await service.resendActivation(ORG, USER);

      expect(onboarding.createActivation).toHaveBeenCalledWith({
        userId: USER,
        userName: 'Ana Miembro',
        userEmail: 'ana@zentikk.test',
        organizationName: 'Zentikk',
      });
    });

    it('audita con organization.member.activation_resent', async () => {
      await service.resendActivation(ORG, USER);

      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          action: 'organization.member.activation_resent',
          newData: { userId: USER, email: 'ana@zentikk.test' },
        }),
      );
    });

    it('devuelve el mensaje de exito', async () => {
      await expect(service.resendActivation(ORG, USER)).resolves.toEqual({
        message: 'Email de activación reenviado',
      });
    });

    it('tolera una org sin nombre resoluble (organizationName null)', async () => {
      prisma.organization.findUnique.mockResolvedValue(null as never);

      await service.resendActivation(ORG, USER);

      expect(onboarding.createActivation).toHaveBeenCalledWith(
        expect.objectContaining({ organizationName: null }),
      );
    });
  });

  // ── R2.5: el mail no salio ────────────────────────────────────────────────
  describe('el email no salio de verdad (R2.5)', () => {
    beforeEach(() => {
      onboarding.createActivation.mockResolvedValue({
        mode: 'temp-password',
        tempPassword: 'xxxx',
      } as never);
    });

    it('→ 503 EMAIL_SERVICE_UNAVAILABLE en vez de un 200 mintiendo', async () => {
      const err = await service.resendActivation(ORG, USER).catch((e) => e);

      expect(err).toBeInstanceOf(AppException);
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('EMAIL_SERVICE_UNAVAILABLE');
    });

    it('no audita un reenvio que nunca llego', async () => {
      await service.resendActivation(ORG, USER).catch(() => undefined);

      expect(audit.create).not.toHaveBeenCalled();
    });
  });
});

/**
 * R2.7 — la ruta exige `manage:members`, igual que los otros cinco endpoints de miembros.
 *
 * No es un test de metadata: corre el `PermissionsGuard` REAL contra el handler REAL del
 * controller. Si alguien borra el decorador, el guard devuelve `true` para un usuario sin
 * permisos y el primer caso falla (verificado a mano borrando el decorador).
 */
describe('POST :orgId/members/:userId/resend-activation — permisos (#59 R2.7)', () => {
  const guard = new PermissionsGuard(new Reflector());
  const handler = OrganizationController.prototype.resendMemberActivation;

  function ctx(permissions: string[]): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => OrganizationController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', permissions } }) }),
    } as unknown as ExecutionContext;
  }

  it('sin manage:members → 403', () => {
    const err = (() => {
      try {
        guard.canActivate(ctx(['read:projects']));
        return null;
      } catch (e) {
        return e as AppException;
      }
    })();

    expect(err).toBeInstanceOf(AppException);
    expect(err!.statusCode).toBe(403);
  });

  it('con manage:members → pasa', () => {
    expect(guard.canActivate(ctx(['manage:members']))).toBe(true);
  });
});
