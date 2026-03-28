import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { ProjectBudgetService } from './project-budget.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectBudgetService],
  exports: [ProjectService, ProjectBudgetService],
})
export class ProjectModule {}
