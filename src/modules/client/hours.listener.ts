import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { ClientService } from './client.service';

@Injectable()
export class HoursListener {
  private readonly logger = new Logger(HoursListener.name);

  constructor(
    private readonly clientService: ClientService,
    private readonly prisma: PrismaService,
  ) {}

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

  @OnEvent('task.completed')
  async onTaskCompleted(event: { task: any }) {
    try {
      const task = event.task;
      if (!task || task.type !== 'SUPPORT') return;

      const project = await this.prisma.project.findUnique({
        where: { id: task.projectId },
        select: { clientId: true },
      });
      if (!project?.clientId) return;

      // Use estimatedHours if available, otherwise calculate from creation to completion
      const minutes = task.estimatedHours
        ? task.estimatedHours * 60
        : Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);

      if (minutes > 0) {
        await this.clientService.recordHoursUsage(task.id, minutes);
        this.logger.log(`Auto-consumed ${(minutes / 60).toFixed(2)}h for SUPPORT task ${task.id}`);
      }
    } catch (err) {
      this.logger.error(`Error auto-consuming hours for support task`, err);
    }
  }
}
