import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { TimeEntryService, TimeReportService } from './time-tracking.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import { CreateManualTimeEntryDto } from './dto/create-manual-time-entry.dto';
import { UpdateTimeEntryDto } from './dto/update-time-entry.dto';
import { DeleteTimeEntryDto } from './dto/delete-time-entry.dto';
import { TimeReportFilterDto } from './dto/time-report-filter.dto';

@ApiTags('Time Tracking')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:time-entries')
@Controller()
export class TimeTrackingController {
  constructor(
    private readonly timeEntryService: TimeEntryService,
    private readonly timeReportService: TimeReportService,
  ) {}

  // ============================================
  // CRUD — Entradas de tiempo
  // ============================================

  @Post('time-entries')
  @ApiOperation({ summary: 'Crear entrada de tiempo manual' })
  @HttpCode(HttpStatus.CREATED)
  async createTimeEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTimeEntryDto,
  ) {
    return this.timeEntryService.create(user.id, dto);
  }

  @Post('tasks/:taskId/time-entries')
  @ApiOperation({
    summary: 'Cargar horas manualmente en una tarea (declaración humana con fecha de trabajo)',
  })
  @HttpCode(HttpStatus.CREATED)
  async createManualTimeEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: CreateManualTimeEntryDto,
  ) {
    // Pasa el actor COMPLETO (id + permissions): el service resuelve asignado-vs-PM.
    return this.timeEntryService.createManual(user, taskId, dto);
  }

  @Get('time-entries')
  @ApiOperation({ summary: 'Listar mis entradas de tiempo' })
  async listTimeEntries(
    @CurrentUser() user: AuthenticatedUser,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.timeEntryService.findByUser(user.id, {
      startDate,
      endDate,
      projectId,
    });
  }

  @Patch('time-entries/:id')
  @ApiOperation({ summary: 'Actualizar entrada de tiempo' })
  async updateTimeEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTimeEntryDto,
  ) {
    // Actor completo: habilita al PM (manage:time-entries) a corregir entradas ajenas con traza.
    return this.timeEntryService.update(id, user, dto);
  }

  @Delete('time-entries/:id')
  @ApiOperation({ summary: 'Eliminar entrada de tiempo (soft delete)' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTimeEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeleteTimeEntryDto,
  ) {
    return this.timeEntryService.delete(id, user, dto?.reason);
  }

  // ============================================
  // Reportes de tiempo
  // ============================================

  @Get('projects/:projectId/time-report')
  @ApiOperation({ summary: 'Reporte de tiempo por proyecto' })
  async getProjectTimeReport(
    @Param('projectId') projectId: string,
    @Query() filters: TimeReportFilterDto,
  ) {
    return this.timeReportService.getProjectReport(projectId, filters);
  }

  @Get('users/me/time-report')
  @ApiOperation({ summary: 'Mi reporte de tiempo' })
  async getMyTimeReport(
    @CurrentUser() user: AuthenticatedUser,
    @Query() filters: TimeReportFilterDto,
  ) {
    return this.timeReportService.getUserReport(user.id, filters);
  }
}
