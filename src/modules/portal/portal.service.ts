import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { AppException } from '../../common/filters/app-exception';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';
import { domainEvent } from '../../common/events/domain-event.helper';

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async getClientByUserId(userId: string) {
    const client = await this.prisma.client.findFirst({
      where: { userId },
    });
    if (!client) {
      throw new AppException('No se encontró un perfil de cliente', 'CLIENT_NOT_FOUND', 403);
    }
    return client;
  }

  async getProjects(userId: string) {
    const client = await this.getClientByUserId(userId);

    const projects = await this.prisma.project.findMany({
      where: { clientId: client.id },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
        createdAt: true,
        _count: {
          select: {
            suggestions: true,
          },
        },
        tasks: {
          where: { clientVisible: true },
          select: { status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((p) => {
      const visibleTasks = p.tasks.length;
      const completedTasks = p.tasks.filter((t) => t.status === 'DONE').length;
      const progress = visibleTasks > 0 ? Math.round((completedTasks / visibleTasks) * 100) : 0;

      return {
        id: p.id,
        name: p.name,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        createdAt: p.createdAt,
        suggestionsCount: p._count.suggestions,
        visibleTasks,
        completedTasks,
        progress,
      };
    });
  }

  async getProjectDetail(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        endDate: true,
        alcanceStatus: true,
        alcanceFileId: true,
        alcanceFile: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
        sprints: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            name: true,
            status: true,
            startDate: true,
            endDate: true,
          },
          orderBy: { startDate: 'asc' },
        },
      },
    });

    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const tasks = await this.prisma.task.findMany({
      where: { projectId, clientVisible: true },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        updatedAt: true,
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    const totalVisible = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'DONE').length;
    const progress = totalVisible > 0 ? Math.round((completedTasks / totalVisible) * 100) : 0;

    return {
      ...project,
      tasks,
      totalVisible,
      completedTasks,
      progress,
    };
  }

  async getSuggestions(userId: string, projectId: string) {
    const client = await this.getClientByUserId(userId);

    // Validate project belongs to client
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.findMany({
      where: { projectId, clientId: client.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSuggestion(userId: string, projectId: string, dto: CreateSuggestionDto) {
    const client = await this.getClientByUserId(userId);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, clientId: client.id },
    });
    if (!project) {
      throw new AppException('Proyecto no encontrado', 'PROJECT_NOT_FOUND', 404);
    }

    const suggestion = await this.prisma.suggestion.create({
      data: {
        projectId,
        clientId: client.id,
        title: dto.title,
        description: dto.description,
        priority: dto.priority,
      },
    });

    this.logger.log(`Suggestion created: ${suggestion.id} by client: ${client.id}`);

    this.eventEmitter.emit('suggestion.created', {
      ...domainEvent('suggestion.created', 'suggestion', suggestion.id, project.organizationId, userId),
      suggestionId: suggestion.id,
      title: suggestion.title,
      projectId,
      clientName: client.name,
    });

    return suggestion;
  }

  // ── Admin methods ──────────────────────────────────────

  async getProjectSuggestions(projectId: string) {
    return this.prisma.suggestion.findMany({
      where: { projectId },
      include: {
        client: { select: { id: true, name: true, email: true } },
        task: { select: { id: true, title: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateSuggestion(projectId: string, suggestionId: string, dto: UpdateSuggestionDto) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    return this.prisma.suggestion.update({
      where: { id: suggestionId },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.adminNotes !== undefined && { adminNotes: dto.adminNotes }),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async convertToTask(projectId: string, suggestionId: string) {
    const suggestion = await this.prisma.suggestion.findFirst({
      where: { id: suggestionId, projectId },
    });
    if (!suggestion) {
      throw new AppException('Sugerencia no encontrada', 'SUGGESTION_NOT_FOUND', 404);
    }

    if (suggestion.taskId) {
      throw new AppException('Esta sugerencia ya fue convertida en tarea', 'ALREADY_CONVERTED', 400);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Get a creator user (first org member that isn't a client)
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true, createdById: true },
      });

      const task = await tx.task.create({
        data: {
          projectId,
          title: suggestion.title,
          description: suggestion.description,
          priority: suggestion.priority === 'HIGH' ? 'HIGH' : suggestion.priority === 'LOW' ? 'LOW' : 'MEDIUM',
          createdById: project!.createdById,
          clientVisible: true,
        },
      });

      const updated = await tx.suggestion.update({
        where: { id: suggestionId },
        data: { status: 'IMPLEMENTED', taskId: task.id },
        include: {
          client: { select: { id: true, name: true } },
          task: { select: { id: true, title: true, status: true } },
        },
      });

      return updated;
    });

    this.logger.log(`Suggestion ${suggestionId} converted to task ${result.taskId}`);
    return result;
  }
}
