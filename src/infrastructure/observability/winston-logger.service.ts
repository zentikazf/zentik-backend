import { LoggerService } from '@nestjs/common';
import * as winston from 'winston';

export class WinstonLoggerService implements LoggerService {
  private logger: winston.Logger;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';

    this.logger = winston.createLogger({
      level: this.mapLogLevel(process.env.LOG_LEVEL || 'info'),
      format: isProduction
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json(),
          )
        : winston.format.combine(
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context, stack, ...meta }) => {
              const ctx = context ? `[${context}]` : '';
              const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
              const stackStr = stack ? `\n${stack}` : '';
              return `${timestamp} ${level} ${ctx} ${message}${metaStr}${stackStr}`;
            }),
          ),
      transports: [new winston.transports.Console()],
    });
  }

  log(message: any, context?: string) {
    this.logger.info(this.formatMessage(message), { context });
  }

  error(message: any, stackOrContext?: string) {
    if (typeof message === 'object' && !(message instanceof Error)) {
      this.logger.error({ message: 'error', ...message, stack: stackOrContext });
    } else {
      this.logger.error(this.formatMessage(message), { stack: stackOrContext });
    }
  }

  warn(message: any, context?: string) {
    if (typeof message === 'object') {
      this.logger.warn({ message: 'warning', ...message, context });
    } else {
      this.logger.warn(this.formatMessage(message), { context });
    }
  }

  debug(message: any, context?: string) {
    this.logger.debug(this.formatMessage(message), { context });
  }

  verbose(message: any, context?: string) {
    this.logger.verbose(this.formatMessage(message), { context });
  }

  private formatMessage(message: any): string {
    return typeof message === 'object' ? JSON.stringify(message) : String(message);
  }

  private mapLogLevel(level: string): string {
    const map: Record<string, string> = {
      error: 'error',
      warn: 'warn',
      info: 'info',
      debug: 'debug',
      verbose: 'verbose',
    };
    return map[level] || 'info';
  }
}
