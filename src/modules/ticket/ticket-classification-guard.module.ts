import { Module } from '@nestjs/common';
import { TicketClassificationGuardService } from './ticket-classification-guard.service';

/**
 * #44 — Módulo dedicado del gate de tipificación. Se mantiene aislado (solo
 * depende de PrismaModule global) para que TicketModule y TaskModule puedan
 * inyectar el guard SIN crear dependencia circular entre sí. Mismo criterio que
 * {@link TaskHoursGuardModule}, el molde probado del repo.
 */
@Module({
  providers: [TicketClassificationGuardService],
  exports: [TicketClassificationGuardService],
})
export class TicketClassificationGuardModule {}
