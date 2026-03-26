import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AppConfigService } from '../../config/app.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const url = new URL(config.redisUrl);
        return {
          redis: {
            host: url.hostname,
            port: parseInt(url.port, 10),
            password: url.password || undefined,
            username: url.username || undefined,
          },
        };
      },
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
