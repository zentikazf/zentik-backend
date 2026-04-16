import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { AppConfigService } from '../../config/app.config';
import {
  welcomeEmail,
  verifyEmailTemplate,
  teamInviteEmail,
  clientUserEmail,
  clientSubUserEmail,
  passwordResetEmail,
  passwordChangedEmail,
} from './email-templates';

@Injectable()
export class EmailInvitationService {
  private readonly logger = new Logger(EmailInvitationService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly config: AppConfigService,
  ) {}

  /** Whether email sending is enabled (Resend API key configured) */
  get isEnabled(): boolean {
    return this.emailService.isEnabled;
  }

  /** Send welcome email after user registration */
  async sendWelcomeEmail(email: string, name: string) {
    const loginUrl = `${this.config.webUrl}/login`;
    const html = welcomeEmail(name, loginUrl);
    await this.emailService.send(email, 'Bienvenido a Zentikk', html);
  }

  /** Send email verification with token link */
  async sendVerificationEmail(email: string, name: string, token: string) {
    const verifyUrl = `${this.config.webUrl}/verify-email?token=${token}`;
    const html = verifyEmailTemplate(name, verifyUrl);
    await this.emailService.send(email, 'Verifica tu correo — Zentikk', html);
  }

  /** Send team member invitation email with temporary credentials */
  async sendTeamInviteEmail(params: {
    email: string;
    memberName: string;
    invitedByName: string;
    organizationName: string;
    roleName: string;
    temporaryPassword: string;
  }) {
    const loginUrl = `${this.config.webUrl}/login`;
    const html = teamInviteEmail({
      memberName: params.memberName,
      invitedByName: params.invitedByName,
      organizationName: params.organizationName,
      roleName: params.roleName,
      temporaryPassword: params.temporaryPassword,
      loginUrl,
    });
    await this.emailService.send(
      params.email,
      `Invitacion al equipo de ${params.organizationName}`,
      html,
    );
  }

  /** Send client user portal access email */
  async sendClientUserEmail(params: {
    email: string;
    clientName: string;
    organizationName: string;
    temporaryPassword: string;
  }) {
    const portalUrl = `${this.config.webUrl}/portal`;
    const html = clientUserEmail({
      clientName: params.clientName,
      organizationName: params.organizationName,
      email: params.email,
      temporaryPassword: params.temporaryPassword,
      portalUrl,
    });
    await this.emailService.send(
      params.email,
      `Acceso al Portal de ${params.organizationName}`,
      html,
    );
  }

  /** Send password reset email with time-limited token. Throws if Resend unavailable. */
  async sendPasswordResetEmail(params: {
    email: string;
    name: string;
    resetToken: string;
    expiresInHours: number;
    requestIp?: string;
  }) {
    if (!this.isEnabled) {
      this.logger.error(
        `[CRITICAL] Cannot send password reset email to ${params.email} — RESEND_API_KEY is not configured. Configure RESEND_API_KEY and RESEND_FROM_EMAIL env vars to enable email delivery.`,
      );
      throw new Error('EMAIL_SERVICE_UNAVAILABLE');
    }
    const resetUrl = `${this.config.webUrl}/reset-password?token=${params.resetToken}`;
    const html = passwordResetEmail({
      name: params.name,
      resetUrl,
      expiresInHours: params.expiresInHours,
      requestIp: params.requestIp,
    });
    await this.emailService.send(params.email, 'Restablecer tu contrasena — Onnix', html);
  }

  /** Send informational email after a successful password change. Non-blocking — failures logged only. */
  async sendPasswordChangedEmail(params: {
    email: string;
    name: string;
    changedAt: Date;
    ipAddress?: string;
  }) {
    if (!this.isEnabled) {
      this.logger.warn(
        `[INFO] Password-change notification skipped for ${params.email} — RESEND_API_KEY not configured. Not blocking user flow.`,
      );
      return;
    }
    const supportUrl = `${this.config.webUrl}/profile/security`;
    const html = passwordChangedEmail({
      name: params.name,
      changedAt: params.changedAt,
      ipAddress: params.ipAddress,
      supportUrl,
    });
    await this.emailService.send(params.email, 'Tu contrasena fue actualizada — Onnix', html);
  }

  /** Send client sub-user invitation email */
  async sendClientSubUserEmail(params: {
    email: string;
    userName: string;
    clientName: string;
    organizationName: string;
    temporaryPassword: string;
  }) {
    const portalUrl = `${this.config.webUrl}/portal`;
    const html = clientSubUserEmail({
      userName: params.userName,
      clientName: params.clientName,
      organizationName: params.organizationName,
      email: params.email,
      temporaryPassword: params.temporaryPassword,
      portalUrl,
    });
    await this.emailService.send(
      params.email,
      `Invitacion al Portal — ${params.organizationName}`,
      html,
    );
  }
}
