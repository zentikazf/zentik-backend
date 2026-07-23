import { Module } from '@nestjs/common';
import { TaskHoursGuardService } from './task-hours-guard.service';

/**
 * Módulo dedicado del gate de horas H6. Se mantiene aislado (solo depende de
 * PrismaModule global + EventEmitter global) para que TaskModule, BoardModule y
 * TicketModule puedan inyectar el guard SIN crear dependencia circular entre sí.
 */
@Module({
  providers: [TaskHoursGuardService],
  exports: [TaskHoursGuardService],
})
export class TaskHoursGuardModule {}
