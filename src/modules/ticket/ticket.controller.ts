import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { TicketService } from './ticket.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { CreateCategoryConfigDto, UpdateCategoryConfigDto } from './dto/create-category-config.dto';
import { UpsertSlaConfigDto } from './dto/upsert-sla-config.dto';
import { UpsertBusinessHoursDto } from './dto/upsert-business-hours.dto';

@ApiTags('Tickets')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  // ── Tickets ──────────────────────────────────────────────

  @Get('organizations/:orgId/tickets')
  @ApiOperation({ summary: 'Listar todos los tickets de la organizacion' })
  @ApiQuery({ name: 'status', required: false, enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'createdByUserId', required: false })
  @ApiQuery({ name: 'categoryConfigId', required: false })
  getOrgTickets(
    @Param('orgId') orgId: string,
    @Query('status') status?: string,
    @Query('clientId') clientId?: string,
    @Query('search') search?: string,
    @Query('createdByUserId') createdByUserId?: string,
    @Query('categoryConfigId') categoryConfigId?: string,
  ) {
    return this.ticketService.getOrgTickets(orgId, status, clientId, search, createdByUserId, categoryConfigId);
  }

  @Post('organizations/:orgId/tickets')
  @ApiOperation({ summary: 'Crear ticket desde el dashboard admin' })
  @HttpCode(HttpStatus.CREATED)
  createTicket(
    @Param('orgId') orgId: string,
    @Body() dto: CreateAdminTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketService.createTicket(orgId, dto, user.id);
  }

  @Get('projects/:projectId/tickets')
  @ApiOperation({ summary: 'Listar tickets de un proyecto' })
  getProjectTickets(@Param('projectId') projectId: string) {
    return this.ticketService.getProjectTickets(projectId);
  }

  @Get('tickets/:ticketId')
  @ApiOperation({ summary: 'Detalle de un ticket' })
  getTicketDetail(@Param('ticketId') ticketId: string) {
    return this.ticketService.getTicketDetail(ticketId);
  }

  @Patch('tickets/:ticketId')
  @ApiOperation({ summary: 'Actualizar estado y notas de un ticket' })
  updateTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.ticketService.updateTicket(ticketId, dto);
  }

  // ── Ticket Category Configs ──────────────────────────────

  @Get('organizations/:orgId/ticket-categories')
  @ApiOperation({ summary: 'Listar categorías de ticket configurables' })
  getCategories(@Param('orgId') orgId: string) {
    return this.ticketService.getCategories(orgId);
  }

  @Post('organizations/:orgId/ticket-categories')
  @ApiOperation({ summary: 'Crear categoría de ticket' })
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @Param('orgId') orgId: string,
    @Body() dto: CreateCategoryConfigDto,
  ) {
    return this.ticketService.createCategory(orgId, dto);
  }

  @Patch('organizations/:orgId/ticket-categories/:categoryId')
  @ApiOperation({ summary: 'Actualizar categoría de ticket' })
  updateCategory(
    @Param('orgId') orgId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryConfigDto,
  ) {
    return this.ticketService.updateCategory(orgId, categoryId, dto);
  }

  @Delete('organizations/:orgId/ticket-categories/:categoryId')
  @ApiOperation({ summary: 'Desactivar categoría de ticket' })
  deleteCategory(
    @Param('orgId') orgId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.ticketService.deleteCategory(orgId, categoryId);
  }

  // ── SLA Config ───────────────────────────────────────────

  @Get('organizations/:orgId/sla-config')
  @ApiOperation({ summary: 'Obtener configuración de SLA por organización' })
  getSlaConfigs(@Param('orgId') orgId: string) {
    return this.ticketService.getSlaConfigs(orgId);
  }

  @Patch('organizations/:orgId/sla-config')
  @ApiOperation({ summary: 'Crear o actualizar configuración de SLA' })
  upsertSlaConfig(
    @Param('orgId') orgId: string,
    @Body() dto: UpsertSlaConfigDto,
  ) {
    return this.ticketService.upsertSlaConfigs(orgId, dto);
  }

  // ── Business Hours ───────────────────────────────────────

  @Get('organizations/:orgId/business-hours')
  @ApiOperation({ summary: 'Obtener horario hábil de la organización' })
  getBusinessHours(@Param('orgId') orgId: string) {
    return this.ticketService.getBusinessHours(orgId);
  }

  @Patch('organizations/:orgId/business-hours')
  @ApiOperation({ summary: 'Crear o actualizar horario hábil' })
  upsertBusinessHours(
    @Param('orgId') orgId: string,
    @Body() dto: UpsertBusinessHoursDto,
  ) {
    return this.ticketService.upsertBusinessHours(orgId, dto);
  }

  // ── Holidays ─────────────────────────────────

  @Get('organizations/:orgId/holidays')
  @ApiOperation({ summary: 'Listar feriados de la organización' })
  getHolidays(@Param('orgId') orgId: string) {
    return this.ticketService.getHolidays(orgId);
  }

  @Post('organizations/:orgId/holidays')
  @ApiOperation({ summary: 'Crear un feriado' })
  @HttpCode(HttpStatus.CREATED)
  createHoliday(
    @Param('orgId') orgId: string,
    @Body() dto: { name: string; date: string; recurring?: boolean },
  ) {
    return this.ticketService.createHoliday(orgId, dto);
  }

  @Delete('organizations/:orgId/holidays/:holidayId')
  @ApiOperation({ summary: 'Eliminar un feriado' })
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteHoliday(
    @Param('orgId') orgId: string,
    @Param('holidayId') holidayId: string,
  ) {
    return this.ticketService.deleteHoliday(orgId, holidayId);
  }
}
