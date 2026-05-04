import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TimeEntryStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TimeEntryService } from './time-tracking.service';

/**
 * Listener que sincroniza la estimacion de la tarea con un TimeEntry DRAFT
 * (motor invisible del sistema de horas — Fase B).
 *
 * Eventos escuchados:
 * - task.estimated: usuario seteo/cambio estimatedHours → upsert DRAFT.
 * - task.assigned: tarea asignada → si habia DRAFT huerfano (creado con createdById
 *   como holder), reasignarlo al nuevo asignee. Si no habia DRAFT pero hay estimatedHours,
 *   crear uno ahora.
 */
@Injectable()
export class TimeEntryListener {
  private readonly logger = new Logger(TimeEntryListener.name);

  constructor(
    private readonly timeEntryService: TimeEntryService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('task.estimated')
  async onTaskEstimated(event: { taskId: string; estimatedHours: number }) {
    try {
      const { taskId, estimatedHours } = event;

      if (!estimatedHours || estimatedHours <= 0) {
        this.logger.log(`Task ${taskId} con estimatedHours=0 — no se crea DRAFT`);
        return;
      }

      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          createdById: true,
          assignments: { select: { userId: true } },
        },
      });
      if (!task) return;

      let holderUserId: string;
      if (task.assignments.length === 1) {
        holderUserId = task.assignments[0].userId;
      } else if (task.assignments.length === 0) {
        // Sin asignee: usamos createdById como holder. Se reasigna en task.assigned.
        holderUserId = task.createdById;
        this.logger.warn(
          `Task ${taskId} sin asignee — DRAFT creado con holder=createdById (${task.createdById})`,
        );
      } else {
        // Multi-asignee: caso futuro no soportado todavia.
        this.logger.warn(
          `Task ${taskId} con ${task.assignments.length} asignees — no se crea DRAFT (multi-asignee no soportado)`,
        );
        return;
      }

      await this.timeEntryService.upsertDraftFromTask(taskId, estimatedHours, holderUserId);
      this.logger.log(
        `DRAFT TimeEntry upsert para task ${taskId} con ${estimatedHours}h (holder=${holderUserId})`,
      );
    } catch (err) {
      this.logger.error(`Error en onTaskEstimated`, err);
    }
  }

  @OnEvent('task.assigned')
  async onTaskAssigned(event: { taskId: string; assigneeId: string }) {
    try {
      const { taskId, assigneeId } = event;

      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { estimatedHours: true, createdById: true },
      });
      if (!task) return;

      // Buscar si hay DRAFT (puede ser huerfano del createdById o ya asignado)
      const draft = await this.prisma.timeEntry.findFirst({
        where: { taskId, status: TimeEntryStatus.DRAFT },
      });

      // Caso 1: hay DRAFT huerfano (creado con createdById) → reasignar al nuevo asignee.
      if (draft && draft.userId === task.createdById && draft.userId !== assigneeId) {
        await this.prisma.timeEntry.update({
          where: { id: draft.id },
          data: { userId: assigneeId },
        });
        this.logger.log(`DRAFT ${draft.id} reasignado de holder ${draft.userId} a asignee ${assigneeId}`);
        return;
      }

      // Caso 2: no hay DRAFT pero la tarea tiene estimatedHours → crear DRAFT ahora.
      if (!draft && task.estimatedHours && task.estimatedHours > 0) {
        await this.timeEntryService.upsertDraftFromTask(taskId, task.estimatedHours, assigneeId);
        this.logger.log(`DRAFT creado al asignar task ${taskId} a assigneeId=${assigneeId}`);
      }
    } catch (err) {
      this.logger.error(`Error en onTaskAssigned`, err);
    }
  }
}
