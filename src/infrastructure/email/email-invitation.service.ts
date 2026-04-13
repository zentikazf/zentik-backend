import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { AppConfigService } from '../../config/app.config';
import {
  welcomeEmail,
  teamInviteEmail,
  clientUserEmail,
  clientSubUserEmail,
} from './email-templates';

@Injectable()
export class EmailInvitationService {
  private readonly logger = new Logger(EmailInvitationService.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly config: AppConfigService,
  ) {}

  /** Send welcome email after user registration */
  async sendWelcomeEmail(email: string, name: string) {
    const loginUrl = `${this.config.webUrl}/login`;
    const html = welcomeEmail(name, loginUrl);
    await this.emailService.send(email, 'Bienvenido a Zentikk', html);
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
