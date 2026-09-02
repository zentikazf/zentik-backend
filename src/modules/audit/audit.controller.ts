import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:audit')
@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('organizations/:orgId/audit-log')
  @ApiOperation({ summary: 'Log de actividad de la organizacion (solo admins)' })
  async listByOrganization(
    @Param('orgId') orgId: string,
    @Query() query: ListAuditQueryDto,
  ) {
    // #67: los `@ApiQuery` manuales se fueron con el DTO. Swagger ahora saca `page`/`limit` de
    // los `@ApiPropertyOptional`, que ademas documentan el minimo y el maximo reales.
    return this.auditService.listByOrganization(orgId, query.page!, query.limit!);
  }

  @Get('projects/:projectId/activity')
  @ApiOperation({ summary: 'Feed de actividad del proyecto' })
  async listByProject(
    @Param('projectId') projectId: string,
    @Query() query: ListAuditQueryDto,
  ) {
    return this.auditService.listByProject(projectId, query.page!, query.limit!);
  }

  @Get('tasks/:taskId/activity')
  @ApiOperation({ summary: 'Feed de actividad de la tarea' })
  async listByTask(
    @Param('taskId') taskId: string,
    @Query() query: ListAuditQueryDto,
  ) {
    return this.auditService.listByTask(taskId, query.page!, query.limit!);
  }
}
