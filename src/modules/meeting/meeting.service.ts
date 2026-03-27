import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { domainEvent } from '../../common/events/domain-event.helper';
import { CreateMeetingDto, UpdateMeetingDto } from './dto';

@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(projectId: string, dto: CreateMeetingDto, userId: string) {
    const meeting = await this.prisma.meeting.create({
      data: {
        projectId,
        title: dto.title,
        description: dto.description,
        date: new Date(dto.date),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        location: dto.location,
        notifyClient: dto.notifyClient ?? false,
        createdById: userId,
      },
      include: {
        createdBy: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, organizationId: true } },
      },
    });

    this.logger.log(`Meeting created: ${meeting.id} for project ${projectId}`);

    this.eventEmitter.emit('meeting.created', {
      ...domainEvent('meeting.created', 'meeting', meeting.id, meeting.project.organizationId, userId, {
        title: meeting.title,
        date: meeting.date,
        projectId,
        projectName: meeting.project.name,
        location: meeting.location,
      }),
      meetingId: meeting.id,
      title: meeting.title,
      date: meeting.date,
      projectId,
      notifyClient: dto.notifyClient ?? false,
      createdById: userId,
    });

    return meeting;
  }

  async findByProject(projectId: string, startDate?: string, endDate?: string) {
    const where: any = { projectId };

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    return this.prisma.meeting.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });
  }

  async findById(meetingId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      include: {
        createdBy: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
    });

    if (!meeting) {
      throw new AppException('La reunión no existe', 'MEETING_NOT_FOUND', 404, { meetingId });
    }

    return meeting;
  }

  async update(meetingId: string, dto: UpdateMeetingDto, userId: string) {
    await this.findById(meetingId);

    const meeting = await this.prisma.meeting.update({
      where: { id: meetingId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.date !== undefined && { date: new Date(dto.date) }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate ? new Date(dto.endDate) : null }),
        ...(dto.location !== undefined && { location: dto.location }),
        ...(dto.notifyClient !== undefined && { notifyClient: dto.notifyClient }),
      },
      include: {
        createdBy: { select: { id: true, name: true } },
      },
    });

    const project = await this.prisma.project.findUnique({ where: { id: meeting.projectId }, select: { organizationId: true } });

    this.eventEmitter.emit('meeting.updated', {
      ...domainEvent('meeting.updated', 'meeting', meetingId, project!.organizationId, userId, {
        title: meeting.title,
        date: meeting.date,
      }),
    });

    this.logger.log(`Meeting updated: ${meetingId} by user ${userId}`);
    return meeting;
  }

  async delete(meetingId: string, userId: string) {
    const meeting = await this.findById(meetingId);
    const project = await this.prisma.project.findUnique({ where: { id: meeting.projectId }, select: { organizationId: true } });

    await this.prisma.meeting.delete({ where: { id: meetingId } });

    this.eventEmitter.emit('meeting.deleted', {
      ...domainEvent('meeting.deleted', 'meeting', meetingId, project!.organizationId, userId, {
        title: meeting.title,
      }),
    });

    this.logger.log(`Meeting deleted: ${meetingId} by user ${userId}`);
    return { deleted: true };
  }
}
