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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { TicketService } from './ticket.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';
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

  @Get('organizations/:orgId/tickets/open-count')
  @ApiOperation({ summary: 'Contar tickets abiertos de la organizacion' })
  getOpenTicketsCount(@Param('orgId') orgId: string) {
    return this.ticketService.getOpenTicketsCount(orgId);
  }

  @Get('organizations/:orgId/tickets/stats')
  @ApiOperation({ summary: 'Contadores de tickets por estado' })
  getTicketStats(@Param('orgId') orgId: string) {
    return this.ticketService.getTicketStats(orgId);
  }

  @Get('organizations/:orgId/tickets')
  @ApiOperation({ summary: 'Listar tickets de la organizacion (cursor pagination)' })
  getOrgTickets(
    @Param('orgId') orgId: string,
    @Query() query: ListTicketsQueryDto,
  ) {
    return this.ticketService.getOrgTickets(orgId, query);
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

  @Get('tickets/:ticketId/events')
  @ApiOperation({ summary: 'Timeline de eventos del ticket (audit log unificado)' })
  getTicketEvents(@Param('ticketId') ticketId: string) {
    return this.ticketService.getTicketEvents(ticketId);
  }

  @Patch('tickets/:ticketId')
  @ApiOperation({ summary: 'Actualizar estado, asignado y notas del ticket' })
  updateTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketService.updateTicket(ticketId, dto, user.id);
  }

  @Post('tickets/:ticketId/close')
  @ApiOperation({ summary: 'Cerrar ticket con motivo' })
  @HttpCode(HttpStatus.OK)
  closeTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: CloseTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketService.closeTicket(ticketId, dto, user.id);
  }

  // ── Ticket Category Configs ──────────────────────────────

  @Get('organizations/:orgId/ticket-categories')
  @ApiOperation({ summary: 'Listar categorias de ticket configurables' })
  getCategories(@Param('orgId') orgId: string) {
    return this.ticketService.getCategories(orgId);
  }

  @Post('organizations/:orgId/ticket-categories')
  @ApiOperation({ summary: 'Crear categoria de ticket' })
  @HttpCode(HttpStatus.CREATED)
  createCategory(
    @Param('orgId') orgId: string,
    @Body() dto: CreateCategoryConfigDto,
  ) {
    return this.ticketService.createCategory(orgId, dto);
  }

  @Patch('organizations/:orgId/ticket-categories/:categoryId')
  @ApiOperation({ summary: 'Actualizar categoria de ticket' })
  updateCategory(
    @Param('orgId') orgId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryConfigDto,
  ) {
    return this.ticketService.updateCategory(orgId, categoryId, dto);
  }

  @Delete('organizations/:orgId/ticket-categories/:categoryId')
  @ApiOperation({ summary: 'Desactivar categoria de ticket' })
  deleteCategory(
    @Param('orgId') orgId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.ticketService.deleteCategory(orgId, categoryId);
  }

  // ── SLA Config ───────────────────────────────────────────

  @Get('organizations/:orgId/sla-config')
  @ApiOperation({ summary: 'Obtener configuracion de SLA por organizacion' })
  getSlaConfigs(@Param('orgId') orgId: string) {
    return this.ticketService.getSlaConfigs(orgId);
  }

  @Patch('organizations/:orgId/sla-config')
  @ApiOperation({ summary: 'Crear o actualizar configuracion de SLA' })
  upsertSlaConfig(
    @Param('orgId') orgId: string,
    @Body() dto: UpsertSlaConfigDto,
  ) {
    return this.ticketService.upsertSlaConfigs(orgId, dto);
  }

  // ── Business Hours ───────────────────────────────────────

  @Get('organizations/:orgId/business-hours')
  @ApiOperation({ summary: 'Obtener horario habil' })
  getBusinessHours(@Param('orgId') orgId: string) {
    return this.ticketService.getBusinessHours(orgId);
  }

  @Patch('organizations/:orgId/business-hours')
  @ApiOperation({ summary: 'Crear o actualizar horario habil' })
  upsertBusinessHours(
    @Param('orgId') orgId: string,
    @Body() dto: UpsertBusinessHoursDto,
  ) {
    return this.ticketService.upsertBusinessHours(orgId, dto);
  }

  // ── Holidays ─────────────────────────────────

  @Get('organizations/:orgId/holidays')
  @ApiOperation({ summary: 'Listar feriados' })
  getHolidays(@Param('orgId') orgId: string) {
    return this.ticketService.getHolidays(orgId);
  }

  @Post('organizations/:orgId/holidays')
  @ApiOperation({ summary: 'Crear feriado' })
  @HttpCode(HttpStatus.CREATED)
  createHoliday(
    @Param('orgId') orgId: string,
    @Body() dto: { name: string; date: string; recurring?: boolean },
  ) {
    return this.ticketService.createHoliday(orgId, dto);
  }

  @Delete('organizations/:orgId/holidays/:holidayId')
  @ApiOperation({ summary: 'Eliminar feriado' })
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteHoliday(
    @Param('orgId') orgId: string,
    @Param('holidayId') holidayId: string,
  ) {
    return this.ticketService.deleteHoliday(orgId, holidayId);
  }
}
