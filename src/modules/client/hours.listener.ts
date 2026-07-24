import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../database/prisma.service';
import { ClientService } from './client.service';

/**
 * Listener de horas del cliente (Fase B — TimeEntry como motor invisible).
 *
 * Cambio respecto a la version vieja:
 * - YA NO escucha task.completed ni task.reopened.
 * - Ahora escucha time_entry.confirmed → descuenta del cupo del cliente
 *   usando TimeEntry.duration (en segundos).
 * - Ahora escucha time_entry.reverted → revierte el descuento via REFUND.
 * - Aplica SOLO a tareas SUPPORT (H1: PROJECT no descuenta; el guard vive en recordHoursUsage).
 *
 * Salvaguardas:
 * 1. legacyMigration=true → SKIP (descuento ya estaba hecho con la logica vieja).
 * 2. duration <= 0 → SKIP.
 * 3. Sin cliente vinculado al proyecto → SKIP (con log).
 */
@Injectable()
export class HoursListener {
  private readonly logger = new Logger(HoursListener.name);

  constructor(
    private readonly clientService: ClientService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('time_entry.confirmed')
  async onTimeEntryConfirmed(event: {
    timeEntryId: string;
    taskId: string;
    duration: number; // segundos
    legacyMigration: boolean;
    version?: number; // H2: ciclo de confirm (clave de idempotencia). Opcional por compat de eventos viejos.
    workedOn?: Date | null; // H8a: fecha real de trabajo. Opcional (carriers legacy no lo traen → default now()).
  }) {
    try {
      const { timeEntryId, taskId, duration, legacyMigration, version, workedOn } = event;

      // Salvaguarda 1: legacy migration → no descontar (descuento ya hecho con logica vieja)
      if (legacyMigration) {
        this.logger.log(`TimeEntry ${timeEntryId} es legacy — skip descuento`);
        return;
      }

      // Salvaguarda 2: duration debe ser > 0
      if (!duration || duration <= 0) {
        this.logger.log(`TimeEntry ${timeEntryId} con duration=${duration} — skip descuento`);
        return;
      }

      // Convertir segundos → minutos para el clientService.recordHoursUsage
      const minutes = Math.round(duration / 60);
      this.logger.log(
        `time_entry.confirmed → descontando ${minutes} min (${(minutes / 60).toFixed(2)}h) para task ${taskId}`,
      );

      // H2: forwardear timeEntryId + version → recordHoursUsage los graba y el único parcial impide
      // el doble cobro si este mismo confirm se procesara dos veces.
      await this.clientService.recordHoursUsage(taskId, minutes, {
        timeEntryId,
        entryVersion: version ?? 1,
        workedOn, // H8a: forward del día trabajado (undefined en carriers legacy → recordHoursUsage cae a now())
      });
    } catch (err) {
      this.logger.error('Error descontando horas tras time_entry.confirmed', err);
    }
  }

  @OnEvent('time_entry.reverted')
  async onTimeEntryReverted(event: {
    timeEntryId: string;
    taskId: string;
    duration: number;
    entryVersion?: number; // H7: si viene, keyea el refund al cobro EXACTO de esta carga.
  }) {
    try {
      const { timeEntryId, taskId, entryVersion } = event;

      // H7: con (timeEntryId, entryVersion) reembolsamos el cobro EXACTO de esta carga MANUAL,
      // no "el más reciente" (que sub-reembolsaría cuando una tarea tiene N cargas). Sin version
      // (carrier legacy pre-H7) caemos al comportamiento anterior: la USAGE/LOAN más reciente.
      const keyed = !!timeEntryId && entryVersion != null;
      const txn = await this.prisma.hoursTransaction.findFirst({
        where: {
          taskId,
          type: { in: ['USAGE', 'LOAN'] },
          ...(keyed ? { timeEntryId, entryVersion } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!txn) {
        this.logger.log(`TimeEntry ${timeEntryId}: no se encontro cobro para task ${taskId} (keyed=${keyed}) — nada que revertir`);
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.hoursTransaction.create({
          data: {
            clientId: txn.clientId,
            type: 'REFUND',
            hours: txn.hours,
            taskId,
            note: `Reversion de cupo por rechazo/reapertura (H7)`,
            workedOn: txn.workedOn ?? txn.createdAt, // H8a: netea contra el período del cobro original, no la fecha del revert
          },
        });

        if (txn.type === 'LOAN') {
          await tx.client.update({
            where: { id: txn.clientId },
            data: { loanedHours: { decrement: txn.hours } },
          });
        } else {
          await tx.client.update({
            where: { id: txn.clientId },
            data: { usedHours: { decrement: txn.hours } },
          });
        }
      });

      this.logger.log(`Revertidas ${txn.hours}h (${txn.type} → REFUND) para task ${taskId}`);
    } catch (err) {
      this.logger.error('Error revirtiendo horas tras time_entry.reverted', err);
    }
  }
}
