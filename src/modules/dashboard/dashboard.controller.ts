import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardFilterDto } from './dto';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:projects')
@Controller()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('organizations/:orgId/dashboard')
  @ApiOperation({ summary: 'Dashboard gerencial con KPIs filtrables' })
  async getManagerialDashboard(
    @Param('orgId') orgId: string,
    @Query() filters: DashboardFilterDto,
  ) {
    return this.dashboardService.getManagerialDashboard(orgId, filters);
  }
}
