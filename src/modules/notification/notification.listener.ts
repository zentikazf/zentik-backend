import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationService } from './notification.service';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('task.assigned')
  async handleTaskAssigned(event: {
    taskId: string;
    taskTitle: string;
    assigneeId: string;
    assignedById: string;
    projectId: string;
  }) {
    this.logger.log(`Evento task.assigned recibido para tarea ${event.taskId}`);

    await this.notificationService.create({
      userId: event.assigneeId,
      type: 'TASK_ASSIGNED',
      title: 'Nueva tarea asignada',
      body: `Se te ha asignado la tarea "${event.taskTitle}"`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        assignedById: event.assignedById,
      },
    });
  }

  @OnEvent('task.completed')
  async handleTaskCompleted(event: {
    taskId: string;
    taskTitle: string;
    completedById: string;
    projectId: string;
  }) {
    this.logger.log(`Evento task.completed recibido para tarea ${event.taskId}`);

    await this.notificationService.notifyProjectManagers(event.projectId, {
      type: 'TASK_COMPLETED',
      title: 'Tarea completada',
      body: `La tarea "${event.taskTitle}" ha sido completada`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        completedById: event.completedById,
      },
    });
  }

  @OnEvent('sprint.started')
  async handleSprintStarted(event: {
    sprintId: string;
    sprintName: string;
    projectId: string;
    startedById: string;
  }) {
    this.logger.log(`Evento sprint.started recibido para sprint ${event.sprintId}`);

    await this.notificationService.notifyProjectManagers(event.projectId, {
      type: 'SPRINT_STARTED',
      title: 'Sprint iniciado',
      body: `El sprint "${event.sprintName}" ha comenzado`,
      metadata: {
        sprintId: event.sprintId,
        projectId: event.projectId,
        startedById: event.startedById,
      },
    });
  }

  @OnEvent('user.mentioned')
  async handleUserMentioned(event: {
    mentionedUserId: string;
    mentionedById: string;
    mentionedByName: string;
    context: string;
    contextId: string;
    projectId?: string;
  }) {
    this.logger.log(
      `Evento user.mentioned recibido: usuario ${event.mentionedUserId} mencionado por ${event.mentionedById}`,
    );

    await this.notificationService.create({
      userId: event.mentionedUserId,
      type: 'MENTION',
      title: 'Te han mencionado',
      body: `${event.mentionedByName} te ha mencionado en ${event.context}`,
      metadata: {
        mentionedById: event.mentionedById,
        context: event.context,
        contextId: event.contextId,
        projectId: event.projectId,
      },
    });
  }

  // ============================================
  // APPROVAL EVENTS
  // ============================================

  @OnEvent('task.approval.requested')
  async handleTaskApprovalRequested(event: {
    taskId: string;
    taskTitle: string;
    projectId: string;
    userId: string;
  }) {
    this.logger.log(`Aprobación solicitada para tarea ${event.taskId}`);

    await this.notificationService.notifyProjectResponsible(event.projectId, {
      type: 'TASK_APPROVAL_REQUESTED',
      title: 'Tarea pendiente de aprobación',
      body: `La tarea "${event.taskTitle}" está lista para revisión y necesita tu aprobación para pasar a Deploy`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        requestedById: event.userId,
      },
    });
  }

  @OnEvent('task.approval.approved')
  async handleTaskApprovalApproved(event: {
    taskId: string;
    taskTitle: string;
    projectId: string;
    userId: string;
  }) {
    this.logger.log(`Tarea ${event.taskId} aprobada`);

    await this.notificationService.notifyTaskAssignees(event.taskId, {
      type: 'TASK_APPROVAL_APPROVED',
      title: 'Tarea aprobada',
      body: `Tu tarea "${event.taskTitle}" fue aprobada y movida a Deploy`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        approvedById: event.userId,
      },
    });
  }

  @OnEvent('task.approval.rejected')
  async handleTaskApprovalRejected(event: {
    taskId: string;
    taskTitle: string;
    projectId: string;
    userId: string;
    reason?: string;
    reviewAttempts: number;
  }) {
    this.logger.log(`Tarea ${event.taskId} rechazada (intento #${event.reviewAttempts})`);

    await this.notificationService.notifyTaskAssignees(event.taskId, {
      type: 'TASK_APPROVAL_REJECTED',
      title: 'Tarea rechazada',
      body: `Tu tarea "${event.taskTitle}" fue rechazada y devuelta a Desarrollo.${event.reason ? ` Motivo: ${event.reason}` : ''} (Intento #${event.reviewAttempts})`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        rejectedById: event.userId,
        reason: event.reason,
        reviewAttempts: event.reviewAttempts,
      },
    });
  }

  // ============================================
  // ALCANCE EVENTS
  // ============================================

  @OnEvent('alcance.submitted')
  async handleAlcanceSubmitted(event: { projectId: string; project: any }) {
    this.logger.log(`Alcance enviado para aprobación en proyecto ${event.projectId}`);

    // Notify client user if exists
    if (event.project.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: event.project.clientId },
        select: { userId: true },
      });

      if (client?.userId) {
        await this.notificationService.create({
          userId: client.userId,
          type: 'ALCANCE_SUBMITTED',
          title: 'Alcance pendiente de aprobación',
          body: `El alcance del proyecto "${event.project.name}" está listo para tu revisión`,
          metadata: { projectId: event.projectId },
        });
      }
    }
  }

  @OnEvent('alcance.approved')
  async handleAlcanceApproved(event: { projectId: string; project: any }) {
    this.logger.log(`Alcance aprobado en proyecto ${event.projectId}`);

    await this.notificationService.notifyProjectResponsible(event.projectId, {
      type: 'ALCANCE_APPROVED',
      title: 'Alcance aprobado',
      body: `El alcance del proyecto "${event.project.name}" ha sido aprobado por el cliente`,
      metadata: { projectId: event.projectId },
    });
  }

  @OnEvent('alcance.rejected')
  async handleAlcanceRejected(event: { projectId: string; project: any }) {
    this.logger.log(`Alcance rechazado en proyecto ${event.projectId}`);

    await this.notificationService.notifyProjectResponsible(event.projectId, {
      type: 'ALCANCE_REJECTED',
      title: 'Alcance rechazado',
      body: `El alcance del proyecto "${event.project.name}" ha sido rechazado por el cliente`,
      metadata: { projectId: event.projectId },
    });
  }

  // ============================================
  // TASK UPDATES → Notify responsible
  // ============================================

  @OnEvent('task.updated')
  async handleTaskUpdated(event: {
    taskId: string;
    taskTitle?: string;
    projectId: string;
    userId: string;
  }) {
    if (!event.projectId) return;

    await this.notificationService.notifyProjectResponsible(event.projectId, {
      type: 'TASK_UPDATED',
      title: 'Tarea actualizada',
      body: `La tarea "${event.taskTitle || event.taskId}" ha sido actualizada`,
      metadata: {
        taskId: event.taskId,
        projectId: event.projectId,
        updatedById: event.userId,
      },
    });
  }

  @OnEvent('meeting.created')
  async handleMeetingCreated(event: {
    meetingId: string;
    title: string;
    date: Date;
    projectId: string;
    notifyClient: boolean;
    createdById: string;
  }) {
    if (!event.notifyClient) return;

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: event.projectId },
        select: { name: true, client: { select: { userId: true, name: true } } },
      });

      if (project?.client?.userId) {
        await this.notificationService.create({
          userId: project.client.userId,
          type: 'MEETING_SCHEDULED',
          title: 'Reunión programada',
          body: `Se ha programado la reunión "${event.title}" para el proyecto "${project.name}"`,
          metadata: {
            meetingId: event.meetingId,
            projectId: event.projectId,
            date: event.date,
          },
        });
      }
    } catch (err: any) {
      this.logger.error(`Error notifying client about meeting: ${err?.message}`);
    }
  }

  // ============================================
  // SUGGESTION EVENTS
  // ============================================

  @OnEvent('suggestion.created')
  async handleSuggestionCreated(event: {
    suggestionId: string;
    title: string;
    projectId: string;
    clientName: string;
  }) {
    this.logger.log(`Sugerencia creada: ${event.suggestionId} en proyecto ${event.projectId}`);

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: event.projectId },
        select: {
          name: true,
          responsibleId: true,
          organizationId: true,
        },
      });

      if (!project) return;

      const notificationData = {
        type: 'SUGGESTION_RECEIVED' as const,
        title: 'Nueva sugerencia del cliente',
        body: `${event.clientName} ha enviado la sugerencia "${event.title}" en el proyecto "${project.name}"`,
        metadata: {
          suggestionId: event.suggestionId,
          projectId: event.projectId,
        },
      };

      // Notify project responsible
      if (project.responsibleId) {
        await this.notificationService.create({
          userId: project.responsibleId,
          ...notificationData,
        });
      }

      // Notify Product Owners in the organization
      const poMembers = await this.prisma.organizationMember.findMany({
        where: {
          organizationId: project.organizationId,
          role: { name: 'Product Owner' },
          userId: { not: project.responsibleId ?? undefined },
        },
        select: { userId: true },
      });

      await Promise.all(
        poMembers.map((member) =>
          this.notificationService.create({
            userId: member.userId,
            ...notificationData,
          }),
        ),
      );
    } catch (err: any) {
      this.logger.error(`Error notifying about suggestion: ${err?.message}`);
    }
  }

  // ============================================
  // TICKET EVENTS
  // ============================================

  @OnEvent('ticket.created')
  async handleTicketCreated(event: {
    ticketId: string;
    title: string;
    category: string;
    projectId: string;
    clientName: string;
  }) {
    this.logger.log(`Ticket creado: ${event.ticketId}`);

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: event.projectId },
        select: { responsibleId: true, organizationId: true },
      });

      if (!project) return;

      const notificationData = {
        type: 'TICKET_CREATED' as const,
        title: 'Nuevo ticket de soporte',
        body: `${event.clientName} ha creado el ticket "${event.title}"`,
        metadata: { ticketId: event.ticketId, projectId: event.projectId },
      };

      // Notify project responsible
      if (project.responsibleId) {
        await this.notificationService.create({
          userId: project.responsibleId,
          ...notificationData,
        });
      }

      // Notify Product Owners
      const poMembers = await this.prisma.organizationMember.findMany({
        where: {
          organizationId: project.organizationId,
          role: { name: 'Product Owner' },
          userId: { not: project.responsibleId ?? undefined },
        },
        select: { userId: true },
      });

      await Promise.all(
        poMembers.map((member) =>
          this.notificationService.create({
            userId: member.userId,
            ...notificationData,
          }),
        ),
      );
    } catch (err: any) {
      this.logger.error(`Error notifying about ticket creation: ${err?.message}`);
    }
  }

  @OnEvent('ticket.updated')
  async handleTicketUpdated(event: {
    ticketId: string;
    title: string;
    status: string;
    projectId: string;
    clientId: string;
  }) {
    this.logger.log(`Ticket actualizado: ${event.ticketId} status=${event.status}`);

    try {
      const client = await this.prisma.client.findUnique({
        where: { id: event.clientId },
        select: { userId: true },
      });

      const statusLabels: Record<string, string> = {
        OPEN: 'Abierto',
        IN_PROGRESS: 'En progreso',
        RESOLVED: 'Resuelto',
        CLOSED: 'Cerrado',
      };

      if (client?.userId) {
        await this.notificationService.create({
          userId: client.userId,
          type: 'TICKET_UPDATED',
          title: 'Ticket actualizado',
          body: `Tu ticket "${event.title}" cambio a estado: ${statusLabels[event.status] || event.status}`,
          metadata: { ticketId: event.ticketId, status: event.status },
        });
      }
    } catch (err: any) {
      this.logger.error(`Error notifying about ticket update: ${err?.message}`);
    }
  }
}
