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
}
