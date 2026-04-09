import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../database/prisma.module';
import { TicketController } from './ticket.controller';
import { TicketService } from './ticket.service';
import { SlaCronService } from './sla-cron.service';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [TicketController],
  providers: [TicketService, SlaCronService],
  exports: [TicketService],
})
export class TicketModule {}
