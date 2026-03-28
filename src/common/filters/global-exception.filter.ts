import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { AppConfigService } from '../../config/app.config';
import { AppException } from './app-exception';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly configService: AppConfigService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId = (request.headers['x-correlation-id'] as string) || '';
    const { statusCode, body } = this.buildErrorResponse(exception, correlationId, request);

    const logPayload = {
      correlationId,
      method: request.method,
      url: request.url,
      statusCode,
      userId: (request as any).user?.id,
      orgId: (request as any).user?.organizationId,
      error: body.error.code,
      message: body.error.message,
    };

    if (statusCode >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('correlationId', correlationId);
        scope.setUser({ id: (request as any).user?.id });
        scope.setContext('request', {
          method: request.method,
          url: request.url,
          orgId: (request as any).user?.organizationId,
        });
        Sentry.captureException(exception);
      });
      this.logger.error(logPayload, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(logPayload);
    }

    response.status(statusCode).json(body);
  }

  private buildErrorResponse(exception: unknown, correlationId: string, request: Request) {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.statusCode,
        body: {
          success: false,
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            correlationId,
            timestamp: exception.timestamp,
            path: request.url,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      return {
        statusCode: status,
        body: {
          success: false,
          error: {
            code: this.mapStatusToCode(status),
            message:
              typeof exceptionResponse === 'string'
                ? exceptionResponse
                : (exceptionResponse as any).message,
            details: typeof exceptionResponse === 'object' ? exceptionResponse : undefined,
            correlationId,
            timestamp: new Date().toISOString(),
            path: request.url,
          },
        },
      };
    }

    return {
      statusCode: 500,
      body: {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: this.configService.isProduction
            ? 'Ha ocurrido un error inesperado. Nuestro equipo ha sido notificado.'
            : (exception as Error)?.message || 'Unknown error',
          correlationId,
          timestamp: new Date().toISOString(),
          path: request.url,
        },
      },
    };
  }

  private mapStatusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'VALIDATION_ERROR',
      429: 'RATE_LIMITED',
    };
    return map[status] || 'INTERNAL_ERROR';
  }
}
