import { Module } from '@nestjs/common';
import { NotificationPushService } from './notification-push.service';
import { NotificationPushController } from './notification-push.controller';
import { NotificationPushListener } from './notification-push.listener';

@Module({
  controllers: [NotificationPushController],
  providers: [NotificationPushService, NotificationPushListener],
  exports: [NotificationPushService],
})
export class NotificationPushModule {}
