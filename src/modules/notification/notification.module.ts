import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationListener } from './notification.listener';
import { NotificationPushModule } from '../notification-push/notification-push.module';

@Module({
  imports: [ChatModule, NotificationPushModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationListener],
  exports: [NotificationService],
})
export class NotificationModule {}
