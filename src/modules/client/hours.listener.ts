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

  /**
   * Time entries y timers manuales NO descuentan del cupo de soporte.
   * El cupo de horas del cliente (contractedHours) representa unicamente
   * horas de SOPORTE/CONFIGURACION. Las tareas de tipo PROJECT (desarrollo)
   * se facturan via time entries pero no consumen del cupo.
   *
   * El descuento automatico de cupo sucede unicamente cuando una tarea
   * SUPPORT pasa a DONE (ver onTaskCompleted mas abajo).
   */
  @OnEvent('task.completed')
  async onTaskCompleted(event: { task: any }) {
    try {
      const task = event.task;
      this.logger.log(`task.completed received — task: ${task?.id}, type: ${task?.type}, estimatedHours: ${task?.estimatedHours}`);

      if (!task) {
        this.logger.warn('task.completed event has no task object');
        return;
      }

      if (task.type !== 'SUPPORT') {
        this.logger.log(`Skipping non-SUPPORT task ${task.id} (type: ${task.type})`);
        return;
      }

      const project = await this.prisma.project.findUnique({
        where: { id: task.projectId },
        select: { clientId: true, name: true },
      });

      if (!project?.clientId) {
        this.logger.warn(`Project ${task.projectId} (${project?.name}) has no clientId — cannot deduct hours`);
        return;
      }

      // Use estimatedHours if available, otherwise calculate from creation to completion
      const minutes = task.estimatedHours
        ? task.estimatedHours * 60
        : Math.round((Date.now() - new Date(task.createdAt).getTime()) / 60000);

      this.logger.log(`Deducting ${(minutes / 60).toFixed(2)}h for task ${task.id} (estimatedHours: ${task.estimatedHours}, clientId via project: ${project.clientId})`);

      if (minutes > 0) {
        await this.clientService.recordHoursUsage(task.id, minutes);
        this.logger.log(`Successfully consumed ${(minutes / 60).toFixed(2)}h for SUPPORT task ${task.id}`);
      }
    } catch (err) {
      this.logger.error(`Error auto-consuming hours for support task`, err);
    }
  }

  /**
   * When a SUPPORT task moves FROM DONE back to another status,
   * reverse the hours that were consumed.
   */
  @OnEvent('task.reopened')
  async onTaskReopened(event: { task: any }) {
    try {
      const task = event.task;
      this.logger.log(`task.reopened received — task: ${task?.id}, type: ${task?.type}`);

      if (!task || task.type !== 'SUPPORT') return;

      const project = await this.prisma.project.findUnique({
        where: { id: task.projectId },
        select: { clientId: true },
      });
      if (!project?.clientId) return;

      // Find the USAGE or LOAN transaction for this task and reverse it
      const txn = await this.prisma.hoursTransaction.findFirst({
        where: { taskId: task.id, clientId: project.clientId, type: { in: ['USAGE', 'LOAN'] } },
        orderBy: { createdAt: 'desc' },
      });

      if (!txn) {
        this.logger.log(`No hours transaction found for task ${task.id} — nothing to reverse`);
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        // Create a REFUND transaction
        await tx.hoursTransaction.create({
          data: {
            clientId: project.clientId!,
            type: 'REFUND',
            hours: txn.hours,
            taskId: task.id,
            note: `Reversión: tarea reabierta — ${task.title || task.id}`,
          },
        });

        // Reverse the client counters
        if (txn.type === 'LOAN') {
          await tx.client.update({
            where: { id: project.clientId! },
            data: { loanedHours: { decrement: txn.hours } },
          });
        } else {
          await tx.client.update({
            where: { id: project.clientId! },
            data: { usedHours: { decrement: txn.hours } },
          });
        }
      });

      this.logger.log(`Reversed ${txn.hours}h (${txn.type}) for reopened task ${task.id}`);
    } catch (err) {
      this.logger.error(`Error reversing hours for reopened task`, err);
    }
  }
}
