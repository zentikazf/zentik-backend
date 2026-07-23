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

@Module({
  // ScheduleModule.forRoot() se movio a AppModule (#19 ALTO-2): debe ser unico y
  // global para no registrar un segundo explorer ni colisionar nombres de
  // interval. SlaCronService (@Cron) y los @Interval de los gateways se
  // descubren igual desde el forRoot global.
  // SessionValidityModule (#19 ALTO-2): TicketsGateway revalida la sesion en vivo.
  imports: [PrismaModule, AppConfigModule, OutboxModule, SessionValidityModule, TaskHoursGuardModule],
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
