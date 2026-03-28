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
import { TimeEntryService, TimerService, TimeReportService } from './time-tracking.service';
import { CreateTimeEntryDto } from './dto/create-time-entry.dto';
import { UpdateTimeEntryDto } from './dto/update-time-entry.dto';
import { StartTimerDto } from './dto/start-timer.dto';
import { TimeReportFilterDto } from './dto/time-report-filter.dto';

@ApiTags('Time Tracking')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Permissions('read:time-entries')
@Controller()
export class TimeTrackingController {
  constructor(
    private readonly timeEntryService: TimeEntryService,
    private readonly timerService: TimerService,
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
    return this.timeEntryService.update(id, user.id, dto);
  }

  @Delete('time-entries/:id')
  @ApiOperation({ summary: 'Eliminar entrada de tiempo' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTimeEntry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.timeEntryService.delete(id, user.id);
  }

  // ============================================
  // Timer — Temporizadores en tiempo real
  // ============================================

  @Post('time-entries/start')
  @ApiOperation({ summary: 'Iniciar temporizador en una tarea' })
  async startTimer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartTimerDto,
  ) {
    return this.timerService.start(user.id, dto.taskId);
  }

  @Post('time-entries/stop')
  @ApiOperation({ summary: 'Detener temporizador activo' })
  async stopTimer(@CurrentUser() user: AuthenticatedUser) {
    return this.timerService.stop(user.id);
  }

  @Get('time-entries/active')
  @ApiOperation({ summary: 'Obtener temporizador activo' })
  async getActiveTimer(@CurrentUser() user: AuthenticatedUser) {
    return this.timerService.getActive(user.id);
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
