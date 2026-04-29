import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../database/prisma.module';
import { AppConfigModule } from '../../config/config.module';
import { TicketController } from './ticket.controller';
import { TicketService } from './ticket.service';
import { TicketEventsService } from './ticket-events.service';
import { TicketSyncListener } from './ticket-sync.listener';
import { TicketsGateway } from './tickets.gateway';
import { SlaCronService } from './sla-cron.service';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot(), AppConfigModule],
  controllers: [TicketController],
  providers: [
    TicketService,
    TicketEventsService,
    TicketSyncListener,
    TicketsGateway,
    SlaCronService,
  ],
  exports: [TicketService, TicketEventsService],
})
export class TicketModule {}
