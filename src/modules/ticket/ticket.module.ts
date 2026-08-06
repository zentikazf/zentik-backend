import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AppConfigModule } from '../../config/config.module';
import { TicketController } from './ticket.controller';
import { TicketService } from './ticket.service';
import { TicketEventsService } from './ticket-events.service';
import { TicketSyncListener } from './ticket-sync.listener';
import { TicketsGateway } from './tickets.gateway';
import { SlaCronService } from './sla-cron.service';
import { OutboxModule } from '../sync/outbox.module';
import { SessionValidityModule } from '../auth/session-validity.module';
import { TaskHoursGuardModule } from '../task/task-hours-guard.module';
import { SlaModule } from '../sla/sla.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  // ScheduleModule.forRoot() se movio a AppModule (#19 ALTO-2): debe ser unico y
  // global para no registrar un segundo explorer ni colisionar nombres de
  // interval. SlaCronService (@Cron) y los @Interval de los gateways se
  // descubren igual desde el forRoot global.
  // SessionValidityModule (#19 ALTO-2): TicketsGateway revalida la sesion en vivo.
  // SlaModule (#42 Fase 1): expone SlaResolverService para la cascada de SLA. La
  // dependencia es unidireccional (sla NO importa ticket) → sin ciclo.
  imports: [
    PrismaModule,
    AppConfigModule,
    OutboxModule,
    SessionValidityModule,
    TaskHoursGuardModule,
    SlaModule,
    // #43 R2.4: TicketSyncListener escribe el mensaje de sistema al reabrir por
    // rechazo. ChatModule solo importa PrismaModule + SessionValidityModule →
    // Ticket → Chat es acíclico (Chat no importa Ticket).
    ChatModule,
  ],
  controllers: [TicketController],
  providers: [
    TicketService,
    TicketEventsService,
    TicketSyncListener,
    TicketsGateway,
    SlaCronService,
  ],
  exports: [TicketService, TicketEventsService, TicketsGateway],
})
export class TicketModule {}
