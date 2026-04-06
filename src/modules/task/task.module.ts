import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TaskRelationService } from './task-relation.service';
import { TaskApprovalService } from './task-approval.service';
import { ProjectModule } from '../project/project.module';

@Module({
  imports: [ProjectModule],
  controllers: [TaskController],
  providers: [TaskService, TaskRelationService, TaskApprovalService],
  exports: [TaskService, TaskRelationService, TaskApprovalService],
})
export class TaskModule {}
