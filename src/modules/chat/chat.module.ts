import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChannelService, MessageService } from './chat.service';
import { SessionValidityModule } from '../auth/session-validity.module';
import { OutboxModule } from '../sync/outbox.module';

@Module({
  // SessionValidityModule (#19 ALTO-2): ChatGateway revalida la sesion en vivo
  // (heartbeat @Interval + assertLiveSession). No introduce ciclo: el modulo
  // solo importa PrismaModule.
  // OutboxModule (#50 D5): MessageService encola COMMENT_ADDED en la tx del
  // mensaje. Es el modulo minimo de sync (solo provee OutboxService), asi que no
  // arrastra el cron/controller ni AuthModule — sin ciclos en el grafo, misma
  // instancia que usan TicketModule y PortalModule.
  imports: [PrismaModule, SessionValidityModule, OutboxModule],
  controllers: [ChatController],
  providers: [ChatGateway, ChannelService, MessageService],
  exports: [ChannelService, MessageService, ChatGateway],
})
export class ChatModule {}
