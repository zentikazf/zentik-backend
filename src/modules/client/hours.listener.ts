import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClientService } from './client.service';

@Injectable()
export class HoursListener {
  private readonly logger = new Logger(HoursListener.name);

  constructor(private readonly clientService: ClientService) {}

  @OnEvent('time_entry.created')
  async onTimeEntryCreated(event: { taskId: string; duration: number }) {
    try {
      const durationMinutes = event.duration / 60; // duration is stored as seconds
      if (durationMinutes > 0) {
        await this.clientService.recordHoursUsage(event.taskId, durationMinutes);
      }
    } catch (err) {
      this.logger.error(`Error recording hours usage for task ${event.taskId}`, err);
    }
  }

  @OnEvent('timer.stopped')
  async onTimerStopped(event: { taskId: string; duration: number }) {
    try {
      const durationMinutes = event.duration / 60;
      if (durationMinutes > 0) {
        await this.clientService.recordHoursUsage(event.taskId, durationMinutes);
      }
    } catch (err) {
      this.logger.error(`Error recording hours usage for task ${event.taskId}`, err);
    }
  }
}
