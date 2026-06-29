import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChatGateway } from '../chat/chat.gateway';
import { TicketsGateway } from '../ticket/tickets.gateway';

/**
 * AuthSocketListener — cierra los WebSockets vivos cuando una sesion termina.
 *
 * Seguridad (feature #18, R4 — CRITICO-3 zombie sessions): antes, al hacer logout
 * o revocar una sesion, el token quedaba invalidado pero el socket abierto seguia
 * recibiendo eventos en tiempo real (chat, tickets, notificaciones) hasta que
 * el cliente cerrara la pestana. Este listener desconecta el/los socket(s)
 * correspondiente(s) en AMBOS gateways al instante.
 *
 * Decision del dev:
 * - `user.logged_out` (logout normal de UNA pestana) → desconecta SOLO el socket
 *   de esa sesion (`sessionId`). Las demas sesiones/dispositivos del user siguen.
 * - `user.session_revoked` (revoke puntual o "cerrar todas") → si el payload trae
 *   `sessionId`, desconecta ese; si no (revoke-all), desconecta TODOS los del user.
 *
 * Los emits viven en auth.service.ts (logout ~L174, revokeSession ~L687) y ya
 * incluyen `{ userId, sessionId }`.
 */
@Injectable()
export class AuthSocketListener {
  private readonly logger = new Logger(AuthSocketListener.name);

  constructor(
    private readonly chatGateway: ChatGateway,
    private readonly ticketsGateway: TicketsGateway,
  ) {}

  /**
   * Logout normal: cierra SOLO el socket de esa sesion (por-sesion).
   */
  @OnEvent('user.logged_out')
  async handleLoggedOut(payload: { userId: string; sessionId?: string }) {
    if (!payload?.userId) return;
    this.logger.log(
      `Logout user ${payload.userId} (sessionId ${payload.sessionId ?? 'desconocido'}) — cerrando socket(s)`,
    );
    await this.disconnect(payload.userId, payload.sessionId);
  }

  /**
   * Revoke: por-sesion si trae sessionId; si no (revoke-all), todos los del user.
   */
  @OnEvent('user.session_revoked')
  async handleSessionRevoked(payload: { userId: string; sessionId?: string }) {
    if (!payload?.userId) return;
    this.logger.log(
      `Sesion revocada user ${payload.userId} (sessionId ${payload.sessionId ?? 'todas'}) — cerrando socket(s)`,
    );
    await this.disconnect(payload.userId, payload.sessionId);
  }

  /** Desconecta en ambos gateways. */
  private async disconnect(userId: string, sessionId?: string): Promise<void> {
    await Promise.all([
      this.chatGateway.disconnectUserSockets(userId, sessionId),
      this.ticketsGateway.disconnectUserSockets(userId, sessionId),
    ]);
  }
}
