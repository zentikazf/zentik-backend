export class AppException extends Error {
  public readonly timestamp: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================
// HTTP EXCEPTIONS
// ============================================

export class ValidationException extends AppException {
  constructor(details: Record<string, unknown>) {
    super('Los datos enviados no son validos', 'VALIDATION_ERROR', 422, details);
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = 'Sesion expirada o no autenticado') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenException extends AppException {
  constructor(resource: string, action: string) {
    super(
      `No tienes permiso para ${action} en ${resource}`,
      'FORBIDDEN',
      403,
      { resource, action },
    );
  }
}

// ============================================
// DOMAIN EXCEPTIONS — ZENTIK SPECIFIC
// ============================================

export class ProjectNotFoundException extends AppException {
  constructor(projectId: string) {
    super('El proyecto no existe o fue eliminado', 'PROJECT_NOT_FOUND', 404, { projectId });
  }
}

export class TaskNotFoundException extends AppException {
  constructor(taskId: string) {
    super('La tarea no existe o fue eliminada', 'TASK_NOT_FOUND', 404, { taskId });
  }
}

export class OrganizationNotFoundException extends AppException {
  constructor(orgId: string) {
    super('La organizacion no existe', 'ORGANIZATION_NOT_FOUND', 404, { orgId });
  }
}

export class SprintNotFoundException extends AppException {
  constructor(sprintId: string) {
    super('El sprint no existe', 'SPRINT_NOT_FOUND', 404, { sprintId });
  }
}

export class UserNotFoundException extends AppException {
  constructor(userId: string) {
    super('El usuario no existe en esta organizacion', 'USER_NOT_FOUND', 404, { userId });
  }
}

export class InsufficientPermissionsException extends AppException {
  constructor(userId: string, permission: string) {
    super(
      `Tu rol no incluye el permiso "${permission}". Contacta al administrador de tu organizacion.`,
      'INSUFFICIENT_PERMISSIONS',
      403,
      { userId, requiredPermission: permission },
    );
  }
}

// ============================================
// SaaS-SPECIFIC EXCEPTIONS
// ============================================

export class PlanLimitExceededException extends AppException {
  constructor(resource: string, currentUsage: number, limit: number, plan: string) {
    super(
      `Tu plan ${plan} permite maximo ${limit} ${resource}. Actualiza a Pro para expandir tus limites.`,
      'PLAN_LIMIT_EXCEEDED',
      403,
      { resource, currentUsage, planLimit: limit, currentPlan: plan, suggestedPlan: 'pro' },
    );
  }
}

export class SubscriptionExpiredException extends AppException {
  constructor(orgId: string) {
    super(
      'Tu suscripcion ha expirado. Renueva para continuar usando las funciones Pro.',
      'SUBSCRIPTION_EXPIRED',
      402,
      { orgId },
    );
  }
}

export class FeatureNotAvailableException extends AppException {
  constructor(feature: string, currentPlan: string) {
    super(
      `La funcion "${feature}" no esta disponible en tu plan ${currentPlan}.`,
      'FEATURE_NOT_AVAILABLE',
      403,
      { feature, currentPlan, upgradePath: '/settings/billing' },
    );
  }
}

// ============================================
// CONFLICT EXCEPTIONS
// ============================================

export class DuplicateResourceException extends AppException {
  constructor(resource: string, field: string, value: string) {
    super(
      `Ya existe un ${resource} con ese ${field}`,
      'DUPLICATE_RESOURCE',
      409,
      { resource, field, value },
    );
  }
}

// ============================================
// RATE LIMITING
// ============================================

export class RateLimitException extends AppException {
  constructor(retryAfterSeconds: number) {
    super('Demasiadas peticiones. Intenta de nuevo en unos momentos.', 'RATE_LIMITED', 429, {
      retryAfterSeconds,
    });
  }
}

// ============================================
// EXTERNAL SERVICE EXCEPTIONS
// ============================================

export class ExternalServiceException extends AppException {
  constructor(service: string, originalError?: string) {
    super(
      `El servicio externo "${service}" no esta disponible. Reintentando automaticamente.`,
      'EXTERNAL_SERVICE_ERROR',
      503,
      { service, originalError },
    );
  }
}
