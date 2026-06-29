import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * SessionValidityService — revalidacion de sesion en vivo para sockets (#19 ALTO-2).
 *
 * Los sockets WS se autentican UNA sola vez en el handshake. Despues quedan
 * autenticados indefinidamente aunque la sesion expire por TTL o se revoque
 * silenciosamente (resetPassword/updatePassword/client/org-membership borran
 * filas `Session` sin emitir evento). Este service centraliza el chequeo de
 * validez consumido por el `@Interval` y el `assertLiveSession` de los gateways.
 *
 * Como la revocacion es DELETE fisico (el modelo `Session` NO tiene
 * `revokedAt`/`isActive`), un `findFirst({ id, expiresAt > now })` detecta a la
 * vez revocacion (fila borrada → null) y expiracion TTL. NO renueva `expiresAt`
 * (un socket en pestana background no es actividad real — D2).
 */
@Injectable()
export class SessionValidityService {
  private readonly logger = new Logger(SessionValidityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Devuelve true si la sesion sigue viva (existe y no expiro), false si esta
   * confirmada inexistente/expirada.
   *
   * FAIL-OPEN (obligatorio): la query va en try/catch; ante excepcion de DB
   * (timeout/blip de PG-Railway) loguea y devuelve `true`. NUNCA desconecta un
   * socket por un error de infra — solo por una fila confirmada inexistente. Un
   * `disconnect(true)` produce `'io server disconnect'` que NO auto-reconecta,
   * asi que un falso negativo seria muy costoso.
   */
  async isSessionLive(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      return !!session;
    } catch (error) {
      this.logger.error(
        `isSessionLive: error de DB validando sesion ${sessionId} (fail-open → true)`,
        error as Error,
      );
      return true;
    }
  }
}
