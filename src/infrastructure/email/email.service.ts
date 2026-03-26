import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { AppConfigService } from '../../config/app.config';
import { CircuitBreaker } from '../../common/utils/circuit-breaker';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly circuit = new CircuitBreaker(5, 60_000);

  constructor(private readonly config: AppConfigService) {
    const apiKey = config.sendgridApiKey;
    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.config.sendgridApiKey) {
      this.logger.warn(`Email not sent (no API key): ${subject} → ${to}`);
      return;
    }

    await this.circuit.execute(
      async () => {
        await sgMail.send({
          to,
          from: { email: this.config.sendgridFromEmail, name: this.config.sendgridFromName },
          subject,
          html,
        });
        this.logger.log(`Email sent: ${subject} → ${to}`);
      },
      () => {
        this.logger.warn(`Email circuit open, queuing: ${subject} → ${to}`);
      },
    );
  }
}
