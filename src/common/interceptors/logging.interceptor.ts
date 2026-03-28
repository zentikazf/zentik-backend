import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

// Routes that generate noise in logs (polling, health checks)
const SILENT_ROUTES = [
  '/api/v1/notifications/unread-count',
  '/health',
  '/health/ready',
];

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;

    if (SILENT_ROUTES.some((route) => url.startsWith(route))) {
      return next.handle();
    }

    const correlationId = request.headers['x-correlation-id'] || '';
    const userId = request.user?.id || 'anonymous';
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const duration = Date.now() - now;
        this.logger.log({
          correlationId,
          method,
          url,
          statusCode: response.statusCode,
          userId,
          duration: `${duration}ms`,
        });
      }),
    );
  }
}
