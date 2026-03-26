import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface CalendarEvent {
  id: string;
  title: string;
  type: 'task' | 'sprint_start' | 'sprint_end' | 'project_deadline' | 'meeting';
  startDate: Date;
  endDate?: Date;
  projectId?: string;
  projectName?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getEvents(
    userId: string,
    startDate?: string,
    endDate?: string,
    projectId?: string,
  ): Promise<CalendarEvent[]> {
    const rangeStart = startDate
      ? new Date(startDate)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const rangeEnd = endDate
      ? new Date(endDate)
      : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);

    const projectFilter = projectId ? { projectId } : {};

    const [tasks, sprints, meetings] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          ...projectFilter,
          dueDate: { gte: rangeStart, lte: rangeEnd },
          assignments: { some: { userId } },
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          status: true,
          priority: true,
          projectId: true,
          project: { select: { name: true } },
        },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.sprint.findMany({
        where: {
          ...projectFilter,
          OR: [
            { startDate: { gte: rangeStart, lte: rangeEnd } },
            { endDate: { gte: rangeStart, lte: rangeEnd } },
          ],
        },
        select: {
          id: true,
          name: true,
          startDate: true,
          endDate: true,
          status: true,
          projectId: true,
          project: { select: { name: true } },
        },
        orderBy: { startDate: 'asc' },
      }),
      this.prisma.meeting.findMany({
        where: {
          ...projectFilter,
          date: { gte: rangeStart, lte: rangeEnd },
        },
        select: {
          id: true,
          title: true,
          date: true,
          endDate: true,
          location: true,
          projectId: true,
          project: { select: { name: true } },
        },
        orderBy: { date: 'asc' },
      }),
    ]);

    const events: CalendarEvent[] = [];

    // Task events
    for (const task of tasks) {
      if (task.dueDate) {
        events.push({
          id: `task-${task.id}`,
          title: task.title,
          type: 'task',
          startDate: task.dueDate,
          projectId: task.projectId,
          projectName: task.project.name,
          metadata: {
            taskId: task.id,
            status: task.status,
            priority: task.priority,
          },
        });
      }
    }

    // Sprint events
    for (const sprint of sprints) {
      if (sprint.startDate) {
        events.push({
          id: `sprint-start-${sprint.id}`,
          title: `Inicio: ${sprint.name}`,
          type: 'sprint_start',
          startDate: sprint.startDate,
          endDate: sprint.endDate || undefined,
          projectId: sprint.projectId,
          projectName: sprint.project.name,
          metadata: {
            sprintId: sprint.id,
            status: sprint.status,
          },
        });
      }
      if (sprint.endDate) {
        events.push({
          id: `sprint-end-${sprint.id}`,
          title: `Fin: ${sprint.name}`,
          type: 'sprint_end',
          startDate: sprint.endDate,
          projectId: sprint.projectId,
          projectName: sprint.project.name,
          metadata: {
            sprintId: sprint.id,
            status: sprint.status,
          },
        });
      }
    }

    // Meeting events
    for (const meeting of meetings) {
      events.push({
        id: `meeting-${meeting.id}`,
        title: meeting.title,
        type: 'meeting',
        startDate: meeting.date,
        endDate: meeting.endDate || undefined,
        projectId: meeting.projectId,
        projectName: meeting.project.name,
        metadata: {
          meetingId: meeting.id,
          location: meeting.location,
        },
      });
    }

    // Sort all events by start date
    events.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

    return events;
  }
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  async connect(userId: string, _authCode: string) {
    // Placeholder: Implement Google OAuth2 flow
    // 1. Exchange auth code for tokens
    // 2. Store tokens in database
    // 3. Set up webhook for push notifications
    this.logger.log(`Google Calendar connect requested for user ${userId}`);
    return {
      connected: false,
      message: 'Google Calendar integration pending implementation. OAuth2 flow required.',
    };
  }

  async disconnect(userId: string) {
    // Placeholder: Revoke tokens and remove from database
    this.logger.log(`Google Calendar disconnect requested for user ${userId}`);
    return {
      disconnected: true,
      message: 'Google Calendar desconectado (placeholder)',
    };
  }

  async sync(userId: string) {
    // Placeholder: Sync tasks with due dates to Google Calendar
    this.logger.log(`Google Calendar sync requested for user ${userId}`);
    return {
      synced: false,
      message: 'Google Calendar sync pending implementation',
      lastSyncAt: null,
    };
  }

  async getStatus(userId: string) {
    // Placeholder: Check connection status
    return {
      connected: false,
      lastSyncAt: null,
      email: null,
      message: 'Google Calendar no conectado',
    };
  }
}
