import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ReportService } from './report.service';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:projects')
@Controller()
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Get('organizations/:orgId/reports/overview')
  @ApiOperation({ summary: 'Dashboard ejecutivo de la organizacion' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getOverview(
    @Param('orgId') orgId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getOverview(orgId, startDate, endDate);
  }

  @Get('organizations/:orgId/reports/productivity')
  @ApiOperation({ summary: 'Productividad del equipo' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getProductivity(
    @Param('orgId') orgId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getProductivity(orgId, startDate, endDate);
  }

  @Get('organizations/:orgId/reports/profitability')
  @ApiOperation({ summary: 'Rentabilidad por proyecto' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getProfitability(
    @Param('orgId') orgId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getProfitability(orgId, startDate, endDate);
  }

  @Get('projects/:projectId/reports/burndown')
  @ApiOperation({ summary: 'Grafico burndown del sprint' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getBurndown(
    @Param('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getBurndown(projectId, startDate, endDate);
  }

  @Get('projects/:projectId/reports/velocity')
  @ApiOperation({ summary: 'Grafico de velocidad del equipo' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getVelocity(
    @Param('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getVelocity(projectId, startDate, endDate);
  }

  @Get('projects/:projectId/reports/time-distribution')
  @ApiOperation({ summary: 'Distribucion de tiempo por miembro y tarea' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getTimeDistribution(
    @Param('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getTimeDistribution(projectId, startDate, endDate);
  }

  @Get('users/me/reports/summary')
  @ApiOperation({ summary: 'Resumen de productividad personal' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getPersonalSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reportService.getPersonalSummary(user.id, startDate, endDate);
  }
}
