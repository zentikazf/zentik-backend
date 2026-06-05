import { AppException } from '../../common/filters/app-exception';

/**
 * Errores de dominio del modulo admin-mcp.
 *
 * Defensa en profundidad: estos errores nunca exponen mensajes raw del MCP
 * ni del LLM al cliente. El GlobalExceptionFilter los mapea a HTTP segun la
 * tabla de Decision 9 (design.md) y solo el `message` ya sanitizado de cada
 * excepcion viaja al cliente.
 */

/**
 * Error de upstream desde el MCP HTTP. El `upstreamStatus` original SI se
 * loggea (con redaccion de token) pero NUNCA viaja al cliente.
 */
export class McpUpstreamException extends AppException {
  constructor(
    public readonly upstreamStatus: number,
    public readonly upstreamReason?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    let httpStatus = 502;
    let code = 'MCP_ERROR';
    let userMessage = 'Error del servicio';

    if (upstreamStatus === 401) {
      httpStatus = 401;
      code = 'UNAUTHORIZED';
      userMessage = 'Sesion expirada, vuelva a loguearse';
    } else if (upstreamStatus === 429) {
      httpStatus = 429;
      code = 'TOO_MANY_REQUESTS';
      userMessage = 'Demasiadas consultas, espere un momento';
    } else if (upstreamStatus >= 500 && upstreamStatus < 600) {
      httpStatus = 502;
      code = 'MCP_UNAVAILABLE';
      userMessage = 'El servicio MCP no esta disponible, reintente';
    }

    super(userMessage, code, httpStatus, {
      upstreamStatus,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
}

/**
 * Error del LLM provider (timeout, 401, 429, 5xx, network). NUNCA expone el
 * mensaje original ni el nombre del provider/modelo al cliente.
 */
export class LlmProviderException extends AppException {
  constructor(public readonly providerName: string, public readonly originalMessage?: string) {
    super(
      'El asistente no esta disponible, reintente en unos minutos',
      'LLM_UNAVAILABLE',
      502,
      // providerName y originalMessage SOLO existen para el logger / Sentry,
      // jamas se loggea API key (no es campo aqui), ni el contenido del prompt.
      // El GlobalExceptionFilter expone `details`, asi que aca solo va lo seguro.
      undefined,
    );
  }
}

/**
 * El loop tool_use <-> tool_result alcanzo el cap LLM_MAX_ITERATIONS. NO es
 * un error tecnico — es una respuesta funcional del asistente. El service
 * captura esta excepcion y la traduce a un `ChatResult` con `reply` explicito;
 * NO se propaga al cliente como error HTTP.
 */
export class MaxIterationsException extends AppException {
  constructor(public readonly iterations: number) {
    super(
      'El asistente alcanzo el limite de iteraciones. Reformula tu pregunta.',
      'MAX_ITERATIONS',
      200,
      { iterations },
    );
  }
}
