import { Module } from '@nestjs/common';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { TaskHoursGuardModule } from '../task/task-hours-guard.module';

@Module({
  imports: [TaskHoursGuardModule],
  controllers: [BoardController],
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
