import { Injectable } from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';

/**
 * #44 — Gate "no resolver sin tipificar".
 *
 * Choke point (service-layer) que impide llevar un ticket a RESUELTO sin que el
 * EQUIPO lo haya tipificado. Espejo de {@link TaskHoursGuardService}: predicado
 * barato (`isGatedStatus`) + assert que lanza `AppException` con un `code` estable
 * y `details.missing` rico para que el front sepa qué ofrecer sin adivinar.
 *
 * ⚠️ Si agregás un nuevo writer de `status: 'RESOLVED'`, invocá este guard ANTES
 * de escribir el estado (dentro de la misma tx). Hoy son exactamente tres puntos:
 *  - `TicketService.updateTicket` (PATCH del panel) — assert, lanza.
 *  - `TaskApprovalService.approveTask` (aprobación de la task) — pre-vuelo, lanza.
 *  - `TicketService.syncTicketFromTaskMove` (listener del kanban) — defensivo,
 *    usa `isClassified` y NO lanza (el listener tragaría el throw → divergencia
 *    silenciosa task-DONE / ticket-abierto).
 *
 * Regla operativa (R0, confirmada por el dueño): un ticket está TIPIFICADO cuando
 * tiene `ticketTypeId != null` Y `categoryConfigId != null`. `ticketTypeId` solo
 * no alcanza: el portal lo nace lleno con la elección del CLIENTE. `categoryConfigId`
 * es la prueba de que alguien del equipo miró el ticket.
 */

/** Estados cuya ENTRADA exige tipificación del equipo. Cancelar (CLOSED) NO está acá. */
const GATED_STATUSES: readonly TicketStatus[] = ['RESOLVED'];

/** Cliente prisma o transacción — el gate corre tanto suelto como dentro de una tx. */
type PrismaLike = Prisma.TransactionClient | PrismaService;

/** Contrato con el frontend (`details.missing`): qué eje de la tipificación falta. */
export type MissingClassification = 'ticketType' | 'categoryConfig';

@Injectable()
export class TicketClassificationGuardService {
  constructor(private readonly prisma: PrismaService) {}

  /** true si el status destino está sujeto al gate de tipificación (RESOLVED). */
  isGatedStatus(status?: TicketStatus | string | null): boolean {
    return !!status && GATED_STATUSES.includes(status as TicketStatus);
  }

  /**
   * Lee los dos campos que definen "tipificado" y devuelve los que faltan. Una
   * sola lectura, sin joins. Fuente ÚNICA de la definición de tipificado — no
   * duplicar la condición en los callers.
   */
  private async findMissing(
    ticketId: string,
    tx: PrismaLike,
  ): Promise<MissingClassification[]> {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: { ticketTypeId: true, categoryConfigId: true },
    });
    const missing: MissingClassification[] = [];
    if (!t?.ticketTypeId) missing.push('ticketType');
    if (!t?.categoryConfigId) missing.push('categoryConfig');
    return missing;
  }

  /** Variante booleana para el path defensivo (syncTicketFromTaskMove) que NO lanza. */
  async isClassified(ticketId: string, tx: PrismaLike = this.prisma): Promise<boolean> {
    return (await this.findMissing(ticketId, tx)).length === 0;
  }

  /**
   * Lanza TICKET_CLASSIFICATION_REQUIRED (409) si al ticket le falta tipo o
   * categoría interna. DEBE llamarse dentro de la transacción que escribe el
   * status: si lanza, se revierte el cambio de estado. El mensaje nombra qué
   * falta (R2.4) y `details.missing` es el contrato con el front.
   *
   * @param tx cliente de la MISMA transacción del caller (igual que hoursGuard).
   */
  async assertIsClassified(ticketId: string, tx: PrismaLike = this.prisma): Promise<void> {
    const missing = await this.findMissing(ticketId, tx);
    if (missing.length === 0) return;
    throw new AppException(
      this.buildMessage(missing),
      'TICKET_CLASSIFICATION_REQUIRED',
      409,
      { ticketId, missing },
    );
  }

  /** R2.4: nombra qué falta (tipo, categoría interna o ambos), no un genérico. */
  private buildMessage(missing: MissingClassification[]): string {
    const wantsType = missing.includes('ticketType');
    const wantsCategory = missing.includes('categoryConfig');
    if (wantsType && wantsCategory) {
      return 'Antes de resolver, tipificá el ticket: faltan el tipo de solicitud y la categoría interna.';
    }
    if (wantsType) {
      return 'Antes de resolver, elegí el tipo de solicitud del ticket.';
    }
    return 'Antes de resolver, asigná la categoría interna del ticket.';
  }
}
