import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EmailService } from './email.service';
import { PrismaService } from '../../database/prisma.service';

export interface DispatchPayload {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Dispatcher async para envio de emails sin bloquear el request HTTP.
 *
 * Flujo:
 * 1. dispatch() retorna inmediato; el envio corre en background.
 * 2. Retry exponencial 3 intentos (1s/2s/4s) antes de declarar fallo.
 * 3. Si fallan los 3 intentos: persiste en tabla failed_emails para retry manual.
 * 4. Graceful shutdown: espera hasta 10s a que terminen los envios pending.
 *
 * Right-sized para ~500 emails/dia. Cuando el volumen supere ~5.000/dia,
 * migrar a BullMQ siguiendo el ADR docs/architecture-decisions/2026-05-19-*.
 */
@Injectable()
export class AsyncEmailDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(AsyncEmailDispatcher.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Dispara el envio en background. NO espera a que termine.
   * Errores transitorios se reintentan; fallos finales se persisten en failed_emails.
   */
  dispatch(payload: DispatchPayload): void {
    const promise = this.sendWithRetry(payload)
      .catch((err: any) => {
        this.logger.error(
          `Email descartado tras ${MAX_ATTEMPTS} intentos a ${payload.to}: ${err?.message ?? err}`,
        );
      })
      .finally(() => {
        this.pending.delete(promise);
      });

    this.pending.add(promise);
  }

  private async sendWithRetry(payload: DispatchPayload): Promise<void> {
    let lastError: any;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.emailService.sendOrThrow(
          payload.to,
          payload.subject,
          payload.html,
          payload.fromName ? { fromName: payload.fromName } : undefined,
        );
        if (attempt > 1) {
          this.logger.log(
            `Email enviado a ${payload.to} en intento ${attempt}/${MAX_ATTEMPTS}`,
          );
        }
        return;
      } catch (err: any) {
        lastError = err;
        this.logger.warn(
          `Intento ${attempt}/${MAX_ATTEMPTS} fallo para ${payload.to}: ${err?.message ?? err}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(BACKOFF_MS[attempt - 1]);
        }
      }
    }

    await this.persistFailure(payload, lastError);
    throw lastError;
  }

  private async persistFailure(payload: DispatchPayload, err: any): Promise<void> {
    try {
      await this.prisma.failedEmail.create({
        data: {
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          fromName: payload.fromName ?? null,
          error: String(err?.message ?? err).slice(0, 5000),
          attempts: MAX_ATTEMPTS,
          lastAttemptAt: new Date(),
        },
      });
    } catch (persistErr: any) {
      this.logger.error(
        `No se pudo persistir failed_email para ${payload.to}: ${persistErr?.message ?? persistErr}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pending.size === 0) return;

    this.logger.log(
      `Shutdown: esperando ${this.pending.size} envios pending (timeout ${SHUTDOWN_TIMEOUT_MS}ms)`,
    );

    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, SHUTDOWN_TIMEOUT_MS),
    );

    await Promise.race([
      Promise.allSettled(Array.from(this.pending)),
      timeout,
    ]);

    if (this.pending.size > 0) {
      this.logger.warn(
        `Shutdown forzado con ${this.pending.size} envios sin terminar`,
      );
    }
  }
}
