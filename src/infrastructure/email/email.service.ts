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

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`Email not sent (no API key): "${subject}" → ${to}`);
      return;
    }

    try {
      const { error } = await this.resend.emails.send({
        from: this.config.emailFrom,
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
}
