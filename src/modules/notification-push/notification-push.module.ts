import { Module } from '@nestjs/common';
import { NotificationPushService } from './notification-push.service';
import { NotificationEmailService } from './notification-email.service';
import { NotificationPushController } from './notification-push.controller';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPushListener } from './notification-push.listener';

@Module({
  controllers: [NotificationPushController, NotificationPreferencesController],
  providers: [NotificationPushService, NotificationEmailService, NotificationPushListener],
  exports: [NotificationPushService, NotificationEmailService],
})
export class NotificationPushModule {}
