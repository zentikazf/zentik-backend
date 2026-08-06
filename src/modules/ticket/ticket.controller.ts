import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthGuard, PermissionsGuard, RolesGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { TicketService } from './ticket.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';
import { ReclassifyTicketDto } from './dto/reclassify-ticket.dto';
import { CreateAdminTicketDto } from './dto/create-admin-ticket.dto';
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
  @ApiOperation({ summary: 'Listar tickets de la organizacion (paginacion offset: page/limit)' })
  getOrgTickets(
    @Param('orgId') orgId: string,
    @Query() query: ListTicketsQueryDto,
  ) {
    return this.ticketService.getOrgTickets(orgId, query);
  }

  /**
   * Exportar tickets de la organizacion como CSV.
   *
   * Reutiliza los mismos filtros de GET /organizations/:orgId/tickets,
   * pero NO pagina (devuelve el set completo). Volumen objetivo <500/mes/org.
   *
   * Permission: manage:projects (Owner / PO / PM solamente). Sub-usuarios
   * cliente no acceden — proteccion de campos sensibles (closeReason,
   * adminNotes via export futuro).
   */
  @Get('organizations/:orgId/tickets/export-csv')
  @UseGuards(PermissionsGuard)
  @Permissions('manage:projects')
  @ApiOperation({
    summary: 'Exportar tickets filtrados como CSV (13 columnas, UTF-8 BOM)',
  })
  async exportOrgTicketsCsv(
    @Param('orgId') orgId: string,
    @Query() query: ListTicketsQueryDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const buffer = await this.ticketService.exportTicketsCsv(orgId, query);
    const filename = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
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

  /**
   * Tipificación / reclasificación interna (feature #42 — Fase 2).
   *
   * Solo roles INTERNOS: el cliente reporta, el equipo tipifica. `AuthGuard` ya
   * está a nivel de clase; acá se suma `RolesGuard`. El motivo es obligatorio
   * (lo exige el DTO y lo revalida el service).
   */
  @Patch('organizations/:orgId/tickets/:ticketId/classification')
  @UseGuards(RolesGuard)
  @Roles('Owner', 'Project Manager', 'Developer')
  @ApiOperation({
    summary: 'Reclasificar tipo / criticidad / categoría interna (motivo obligatorio, NO recalcula deadlines)',
  })
  reclassifyTicket(
    @Param('orgId') orgId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: ReclassifyTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ticketService.reclassify(orgId, ticketId, dto, user.id);
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
    return this.ticketService.updateTicket(ticketId, dto, user.id, {
      name: user.name,
      email: user.email,
      permissions: user.permissions,
    });
  }

  // #43: CLOSED se reutiliza como «Cancelado». El endpoint vuelve a estar
  // VIVO (feature #10 lo había tombstoneado con 410): es la ÚNICA puerta al
  // estado CLOSED, con comentario obligatorio (DTO + candado en el service).
  // Cancelar es de staff (R1b.5) — mismo gate de roles que reclassify.
  @Post('tickets/:ticketId/close')
  @UseGuards(RolesGuard)
  @Roles('Owner', 'Project Manager', 'Developer')
  @ApiOperation({
    summary: 'Cancelar ticket (status CLOSED, label «Cancelado») — comentario obligatorio',
  })
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
