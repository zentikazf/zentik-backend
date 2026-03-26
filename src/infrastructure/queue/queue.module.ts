import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AppConfigService } from '../../config/app.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        redis: config.redisUrl,
      }),
      inject: [AppConfigService],
    }),
    BullModule.registerQueue(
      { name: 'email' },
      { name: 'notifications' },
      { name: 'reports' },
      { name: 'files' },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
