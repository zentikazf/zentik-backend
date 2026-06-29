import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChannelService, MessageService } from './chat.service';
import { SessionValidityModule } from '../auth/session-validity.module';

@Module({
  // SessionValidityModule (#19 ALTO-2): ChatGateway revalida la sesion en vivo
  // (heartbeat @Interval + assertLiveSession). No introduce ciclo: el modulo
  // solo importa PrismaModule.
  imports: [PrismaModule, SessionValidityModule],
  controllers: [ChatController],
  providers: [ChatGateway, ChannelService, MessageService],
  exports: [ChannelService, MessageService, ChatGateway],
})
export class ChatModule {}
