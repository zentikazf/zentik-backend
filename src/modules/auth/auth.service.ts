import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import {
  UnauthorizedException,
  DuplicateResourceException,
  AppException,
} from '../../common/filters/app-exception';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { OrganizationService } from '../organization/organization.service';
import { EmailInvitationService } from '../../infrastructure/email/email-invitation.service';

const SALT_ROUNDS = 12;
const SESSION_EXPIRY_MINUTES = 30;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly organizationService: OrganizationService,
    private readonly emailInvitationService: EmailInvitationService,
  ) {}

  async register(dto: RegisterDto, ipAddress?: string, userAgent?: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (existingUser) {
      throw new DuplicateResourceException('usuario', 'email', dto.email);
    }

    const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const emailEnabled = this.emailInvitationService.isEnabled;

    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          emailVerified: !emailEnabled,
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

    // Create personal organization with all 9 SaaS roles + permissions
    await this.organizationService.create(
      { name: `${dto.name}'s Organization` },
      user.id,
    );

    const session = await this.createSession(user.id, ipAddress, userAgent);

    this.eventEmitter.emit('user.registered', {
      userId: user.id,
      email: user.email,
      name: user.name,
      timestamp: new Date().toISOString(),
    });

    // Email verification flow: if Resend is configured, send verification email;
    // otherwise user is already marked as verified and gets a welcome email (no-op without key)
    if (emailEnabled) {
      const verificationToken = randomBytes(32).toString('hex');
      await this.prisma.account.updateMany({
        where: { userId: user.id, providerId: 'credential' },
        data: { idToken: verificationToken },
      });
      this.emailInvitationService.sendVerificationEmail(user.email, user.name, verificationToken).catch((err) => {
        this.logger.error(`Failed to send verification email to ${user.email}`, err);
      });
    }

    this.logger.log(`User registered: ${user.email}`);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
      },
    };
  }

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        accounts: {
          where: { providerId: 'credential' },
          select: { password: true },
        },
      },
    });

    if (!user || !user.accounts[0]?.password) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.accounts[0].password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    const session = await this.createSession(user.id, ipAddress, userAgent);

    this.eventEmitter.emit('user.logged_in', {
      userId: user.id,
      email: user.email,
      ipAddress,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`User logged in: ${user.email}`);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        emailVerified: user.emailVerified,
      },
      session: {
        token: session.token,
        expiresAt: session.expiresAt,
      },
    };
  }

  async logout(sessionToken: string) {
    const session = await this.prisma.session.findFirst({
      where: { token: sessionToken },
      select: { id: true, userId: true },
    });

    if (!session) {
      throw new UnauthorizedException('Sesion no encontrada');
    }

    await this.prisma.session.delete({
      where: { id: session.id },
    });

    this.eventEmitter.emit('user.logged_out', {
      userId: session.userId,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Session revoked: ${session.id}`);

    return { message: 'Sesion cerrada exitosamente' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      this.logger.warn(`Password reset requested for non-existent email: ${dto.email}`);
      return {
        message: 'Si el correo existe en nuestro sistema, recibiras instrucciones para restablecer tu contrasena',
      };
    }

    const resetToken = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + RESET_TOKEN_EXPIRY_HOURS);

    // Store the reset token in the account's accessToken field temporarily
    await this.prisma.account.updateMany({
      where: { userId: user.id, providerId: 'credential' },
      data: {
        accessToken: resetToken,
        accessTokenExpiresAt: expiresAt,
      },
    });

    this.eventEmitter.emit('user.password_reset_requested', {
      userId: user.id,
      email: user.email,
      resetToken,
      expiresAt: expiresAt.toISOString(),
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Password reset requested for: ${user.email}`);

    return {
      message: 'Si el correo existe en nuestro sistema, recibiras instrucciones para restablecer tu contrasena',
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const account = await this.prisma.account.findFirst({
      where: {
        providerId: 'credential',
        accessToken: dto.token,
        accessTokenExpiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });

    if (!account) {
      throw new AppException(
        'El token de restablecimiento es invalido o ha expirado',
        'INVALID_RESET_TOKEN',
        400,
      );
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);

    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        password: hashedPassword,
        accessToken: null,
        accessTokenExpiresAt: null,
      },
    });

    // Invalidate all existing sessions for security
    await this.prisma.session.deleteMany({
      where: { userId: account.userId },
    });

    this.eventEmitter.emit('user.password_reset', {
      userId: account.userId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Password reset completed for user: ${account.userId}`);

    return { message: 'Contrasena restablecida exitosamente. Inicia sesion con tu nueva contrasena.' };
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const account = await this.prisma.account.findFirst({
      where: {
        providerId: 'credential',
        idToken: dto.token,
      },
      select: { id: true, userId: true },
    });

    if (!account) {
      throw new AppException(
        'El token de verificacion es invalido o ha expirado',
        'INVALID_VERIFICATION_TOKEN',
        400,
      );
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: account.userId },
        data: { emailVerified: true },
      }),
      this.prisma.account.update({
        where: { id: account.id },
        data: { idToken: null },
      }),
    ]);

    this.eventEmitter.emit('user.email_verified', {
      userId: account.userId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Email verified for user: ${account.userId}`);

    return { message: 'Correo electronico verificado exitosamente' };
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });

    if (!user) {
      throw new AppException('Usuario no encontrado', 'USER_NOT_FOUND', 404);
    }

    if (user.emailVerified) {
      return { message: 'El correo electronico ya esta verificado' };
    }

    const verificationToken = randomBytes(32).toString('hex');

    await this.prisma.account.updateMany({
      where: { userId: user.id, providerId: 'credential' },
      data: { idToken: verificationToken },
    });

    this.eventEmitter.emit('user.verification_requested', {
      userId: user.id,
      email: user.email,
      token: verificationToken,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Verification email resent for user: ${user.email}`);

    return { message: 'Correo de verificacion reenviado exitosamente' };
  }

  async getSession(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        onboardingCompleted: true,
        mustChangePassword: true,
        createdAt: true,
        organizationMembers: {
          select: {
            organizationId: true,
            roleId: true,
            organization: {
              select: { id: true, name: true, slug: true, logo: true },
            },
            role: {
              select: {
                id: true,
                name: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: { action: true, resource: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        emailVerified: user.emailVerified,
        onboardingCompleted: user.onboardingCompleted,
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt,
      },
      organizations: user.organizationMembers.map((m) => {
        let permissions = m.role.rolePermissions.map(
          (rp) => `${rp.permission.action}:${rp.permission.resource}`,
        );
        // Owner always gets full access
        if (m.role.name === 'Owner' && !permissions.includes('*:*')) {
          permissions = ['*:*'];
        }
        return {
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          logo: m.organization.logo,
          roleId: m.roleId,
          roleName: m.role.name,
          permissions,
        };
      }),
    };
  }

  async changePassword(userId: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new AppException('La contraseña debe tener al menos 6 caracteres', 'INVALID_PASSWORD', 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.account.updateMany({
        where: { userId, providerId: 'credential' },
        data: { password: hashedPassword },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { mustChangePassword: false },
      }),
    ]);

    this.logger.log(`Password changed for user: ${userId}`);
    return { message: 'Contraseña actualizada exitosamente' };
  }

  async completeOnboarding(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingCompleted: true },
    });

    this.logger.log(`Onboarding completed for user: ${userId}`);

    return { success: true };
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return sessions;
  }

  async revokeSession(sessionId: string, userId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
    });

    if (!session) {
      throw new AppException(
        'Sesion no encontrada',
        'SESSION_NOT_FOUND',
        404,
      );
    }

    await this.prisma.session.delete({
      where: { id: sessionId },
    });

    this.eventEmitter.emit('user.session_revoked', {
      userId,
      sessionId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Session ${sessionId} revoked by user ${userId}`);

    return { message: 'Sesion revocada exitosamente' };
  }

  private async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + SESSION_EXPIRY_MINUTES);

    const session = await this.prisma.session.create({
      data: {
        userId,
        token,
        expiresAt,
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
      },
    });

    return session;
  }
}
