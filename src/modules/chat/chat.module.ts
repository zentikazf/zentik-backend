import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChannelService, MessageService } from './chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatGateway, ChannelService, MessageService],
  exports: [ChannelService, MessageService],
})
export class ChatModule {}
