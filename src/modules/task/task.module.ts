import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TaskRelationService } from './task-relation.service';
import { TaskApprovalService } from './task-approval.service';
import { TaskHoursGuardModule } from './task-hours-guard.module';
import { TicketClassificationGuardModule } from '../ticket/ticket-classification-guard.module';
import { ProjectModule } from '../project/project.module';
import { ClientModule } from '../client/client.module';
import { TimeTrackingModule } from '../time-tracking/time-tracking.module';

@Module({
  // #44: TaskApprovalService inyecta el gate de tipificación en approveTask. El
  // guard vive en un módulo standalone (mismo patrón que TaskHoursGuardModule) →
  // sin ciclo Task↔Ticket.
  imports: [ProjectModule, ClientModule, TimeTrackingModule, TaskHoursGuardModule, TicketClassificationGuardModule],
  controllers: [TaskController],
  providers: [TaskService, TaskRelationService, TaskApprovalService],
  exports: [TaskService, TaskRelationService, TaskApprovalService],
})
export class TaskModule {}
