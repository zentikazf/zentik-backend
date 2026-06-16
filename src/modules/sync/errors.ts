import { AppException } from '../../common/filters/app-exception';

/**
 * Errores de dominio del modulo sync (feature #13).
 *
 * Defensa en profundidad: nunca exponen credenciales/token/payload de Onnix al
 * cliente ni a los logs. Solo el `message` sanitizado viaja; el detalle tecnico
 * (status upstream) queda en `details` para el logger.
 *
 * Molde: src/modules/admin-mcp/errors.ts (McpUpstreamException).
 */

/**
 * Error de transporte/upstream contra Onnix (red, timeout, 5xx, 401 de auth real).
 * `upstreamStatus`: 502 red, 504 timeout, o el status HTTP de Onnix. Reintentable
 * segun la clasificacion del dispatcher (§6 ENGINEERING_SPEC).
 */
export class OnnixUpstreamError extends AppException {
  constructor(
    public readonly upstreamStatus: number,
    public readonly upstreamReason?: string,
  ) {
    super(
      'El servicio Onnix no esta disponible',
      'ONNIX_UPSTREAM_ERROR',
      502,
      { upstreamStatus, ...(upstreamReason ? { upstreamReason } : {}) },
    );
  }
}

/**
 * Onnix devolvio 422 (validacion). Terminal por default (catalogo/cliente
 * invalido nunca tendra exito). El dispatcher inspecciona `onnixStatus`/`message`
 * para distinguir el caso idempotente "ya esta en ese estado" (= synced).
 */
export class OnnixValidationError extends AppException {
  constructor(
    public readonly onnixStatus: number,
    public readonly onnixMessage: string,
  ) {
    super(
      'Onnix rechazo la solicitud (validacion)',
      'ONNIX_VALIDATION_ERROR',
      422,
      { onnixStatus },
    );
  }
}

/**
 * El flag ONNIX_SYNC_ENABLED esta on pero faltan secretos (BASE_URL/EMAIL/PASSWORD).
 * Se lanza en runtime al primer uso, NUNCA en el boot (E14): con el flag off la app
 * arranca sin credenciales. Nunca incluye el valor de los secretos.
 */
export class OnnixConfigError extends AppException {
  constructor(missing: string) {
    super(
      'Configuracion de Onnix incompleta',
      'ONNIX_CONFIG_ERROR',
      500,
      { missing },
    );
  }
}
