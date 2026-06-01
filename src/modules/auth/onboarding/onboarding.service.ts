import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../database/prisma.service';
import { AppConfigService } from '../../../config/app.config';
import { EmailService } from '../../../infrastructure/email/email.service';
import { activationEmail } from '../../../infrastructure/email/email-templates';
import { AppException } from '../../../common/filters/app-exception';

const TOKEN_BYTES = 32;
const DEFAULT_EXPIRES_HOURS = 48;
const BCRYPT_ROUNDS = 10;

export interface ActivationCreationResult {
  mode: 'email-sent' | 'temp-password';
  tempPassword?: string;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Crea un token de activacion para el usuario y envia email con link.
   * Si el email service no esta disponible, devuelve un password temporal
   * para que el admin lo muestre en UI (fallback).
   *
   * IMPORTANTE: el caller debe haber creado el user ANTES de llamar a este metodo
   * (sin password o con password placeholder no usable).
   */
  async createActivation(params: {
    userId: string;
    userName: string;
    userEmail: string;
    organizationName?: string | null;
    expiresInHours?: number;
  }): Promise<ActivationCreationResult> {
    if (!this.emailService.isEnabled) {
      // Fallback: caller debe usar el temp password como antes
      this.logger.warn(
        `Email service deshabilitado, no se puede enviar activacion a ${params.userEmail}. Caller debe usar fallback de temp password.`,
      );
      return { mode: 'temp-password', tempPassword: this.generateTempPassword() };
    }

    const expiresInHours = params.expiresInHours ?? DEFAULT_EXPIRES_HOURS;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = this.hashToken(rawToken);

    await this.prisma.userActivationToken.create({
      data: {
        userId: params.userId,
        tokenHash,
        expiresAt,
      },
    });

    const activationUrl = `${this.config.webUrl}/activate/${rawToken}`;
    const html = activationEmail({
      name: params.userName,
      activationUrl,
      expiresInHours,
      organizationName: params.organizationName ?? null,
    });

    const subject = params.organizationName
      ? `[${params.organizationName}] Activa tu cuenta`
      : '[Zentikk] Activa tu cuenta';

    try {
      await this.emailService.sendOrThrow(
        params.userEmail,
        subject,
        html,
        params.organizationName ? { fromName: params.organizationName } : undefined,
      );
      this.logger.log(
        `Email de activacion enviado a ${params.userEmail} (token expira ${expiresAt.toISOString()})`,
      );
      return { mode: 'email-sent' };
    } catch (err: any) {
      this.logger.error(
        `Falla al enviar email de activacion a ${params.userEmail}: ${err?.message ?? err}`,
      );
      // Fallback a temp password si el envio falla — el admin verá la contrasena en UI.
      return { mode: 'temp-password', tempPassword: this.generateTempPassword() };
    }
  }

  /**
   * Verifica que el token sea valido y no este usado/expirado. NO lo consume.
   * Util para previsualizar antes de mostrar el form de activacion.
   */
  async checkToken(rawToken: string): Promise<{ valid: boolean; reason?: string }> {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.userActivationToken.findUnique({
      where: { tokenHash },
    });

    if (!record) return { valid: false, reason: 'NOT_FOUND' };
    if (record.usedAt) return { valid: false, reason: 'ALREADY_USED' };
    if (record.expiresAt < new Date()) return { valid: false, reason: 'EXPIRED' };

    return { valid: true };
  }

  /**
   * Consume el token: setea la contrasena del usuario, marca emailVerified=true
   * y marca el token como usado.
   */
  async activate(rawToken: string, newPassword: string) {
    const tokenHash = this.hashToken(rawToken);

    const record = await this.prisma.userActivationToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    if (!record) {
      throw new AppException('Token de activacion invalido', 'INVALID_TOKEN', 400);
    }
    if (record.usedAt) {
      throw new AppException('Este link de activacion ya fue usado', 'TOKEN_USED', 400);
    }
    if (record.expiresAt < new Date()) {
      throw new AppException(
        'Este link de activacion expiro. Pedile al admin que te envie uno nuevo.',
        'TOKEN_EXPIRED',
        400,
      );
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction([
      // Marcar token como usado (atomico, idempotente)
      this.prisma.userActivationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      // Setear password en la cuenta credential del user
      this.prisma.account.updateMany({
        where: { userId: record.userId, providerId: 'credential' },
        data: { password: hashed },
      }),
      // Marcar email como verificado + clear mustChangePassword
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true, mustChangePassword: false },
      }),
    ]);

    this.logger.log(`Cuenta activada via link: user=${record.userId} (${record.user.email})`);

    return {
      ok: true,
      user: {
        id: record.user.id,
        email: record.user.email,
        name: record.user.name,
      },
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private generateTempPassword(): string {
    // 8 chars alfanumericos, evita 0/O/1/l para legibilidad
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }
}
