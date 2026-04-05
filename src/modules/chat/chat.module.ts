import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChannelService, MessageService } from './chat.service';

@Module({
  imports: [PrismaModule],
  controllers: [ChatController],
  providers: [ChatGateway, ChannelService, MessageService],
  exports: [ChannelService, MessageService, ChatGateway],
})
export class ChatModule {}
