import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { AppConfigService } from '../../config/app.config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;

  constructor(private readonly config: AppConfigService) {
    const apiKey = config.resendApiKey;
    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend email service initialized');
    } else {
      this.logger.warn('RESEND_API_KEY not configured — emails will be logged but not sent');
    }
  }

  /** Whether Resend is configured and emails will actually be sent */
  get isEnabled(): boolean {
    return this.resend !== null;
  }

  async send(
    to: string,
    subject: string,
    html: string,
    options?: { fromName?: string },
  ): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`Email not sent (no API key): "${subject}" → ${to}`);
      return;
    }

    const from = options?.fromName
      ? this.buildFromWithName(options.fromName)
      : this.config.emailFrom;

    try {
      const { error } = await this.resend.emails.send({
        from,
        to,
        subject,
        html,
      });

      if (error) {
        this.logger.error(`Resend error: ${error.message}`, error);
        return;
      }

      this.logger.log(`Email sent: "${subject}" → ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send email: "${subject}" → ${to}`, err);
    }
  }

  /**
   * Construye un sender "fromName <email@dominio>" usando el email del default
   * pero con un display name dinamico. Usado para enviar emails al cliente con
   * branding de su organizacion en vez de "Zentikk".
   */
  private buildFromWithName(fromName: string): string {
    const defaultFrom = this.config.emailFrom;
    // Extraer el email del default: "Zentikk <onnix@zentikk.com>" -> "onnix@zentikk.com"
    const match = defaultFrom.match(/<([^>]+)>/);
    const email = match ? match[1] : defaultFrom;
    // Sanitizar: eliminar comillas dobles del display name para no romper el header
    const safeName = fromName.replace(/"/g, '').trim() || 'Zentikk';
    return `${safeName} <${email}>`;
  }
}
