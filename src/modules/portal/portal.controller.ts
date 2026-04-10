import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { PortalService } from './portal.service';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';
import { CreateTicketDto } from '../ticket/dto/create-ticket.dto';
import { CreateProjectRequestDto } from './dto/create-project-request.dto';

@ApiTags('Portal')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  // ── Client Portal endpoints ──────────────────────────────

  @Get('portal/projects')
  @ApiOperation({ summary: 'Listar proyectos del cliente autenticado' })
  getProjects(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getProjects(user.id);
  }

  @Get('portal/projects/:projectId')
  @ApiOperation({ summary: 'Detalle de proyecto con tareas visibles y progreso' })
  getProjectDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.portalService.getProjectDetail(user.id, projectId);
  }

  @Get('portal/suggestions')
  @ApiOperation({ summary: 'Listar todas las sugerencias globales del cliente' })
  getGlobalSuggestions(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getGlobalSuggestions(user.id);
  }

  @Get('portal/projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Listar sugerencias del cliente en un proyecto' })
  getSuggestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.portalService.getSuggestions(user.id, projectId);
  }

  @Post('portal/projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Crear una sugerencia en un proyecto' })
  @HttpCode(HttpStatus.CREATED)
  createSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateSuggestionDto,
  ) {
    return this.portalService.createSuggestion(user.id, projectId, dto);
  }

  @Post('portal/project-requests')
  @ApiOperation({ summary: 'Solicitar un nuevo proyecto (cliente)' })
  @HttpCode(HttpStatus.CREATED)
  requestProject(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProjectRequestDto,
  ) {
    return this.portalService.requestProject(user.id, dto);
  }

  // ── Admin endpoints (PM/PO) ──────────────────────────────

  @Get('projects/:projectId/suggestions')
  @ApiOperation({ summary: 'Listar sugerencias de un proyecto (admin)' })
  getProjectSuggestions(@Param('projectId') projectId: string) {
    return this.portalService.getProjectSuggestions(projectId);
  }

  @Patch('projects/:projectId/suggestions/:suggestionId')
  @ApiOperation({ summary: 'Actualizar estado/notas de una sugerencia (admin)' })
  updateSuggestion(
    @Param('projectId') projectId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() dto: UpdateSuggestionDto,
  ) {
    return this.portalService.updateSuggestion(projectId, suggestionId, dto);
  }

  @Post('projects/:projectId/suggestions/:suggestionId/convert')
  @ApiOperation({ summary: 'Convertir sugerencia en tarea (admin)' })
  convertToTask(
    @Param('projectId') projectId: string,
    @Param('suggestionId') suggestionId: string,
  ) {
    return this.portalService.convertToTask(projectId, suggestionId);
  }

  // ── Hours endpoint (Portal) ──────────────────────────────

  @Get('portal/hours')
  @ApiOperation({ summary: 'Resumen de horas contratadas del cliente' })
  getMyHours(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getMyHours(user.id);
  }

  // ── Ticket endpoints (Portal) ─────────────────────────────

  @Get('portal/tickets')
  @ApiOperation({ summary: 'Listar tickets del cliente autenticado' })
  getTickets(
    @CurrentUser() user: AuthenticatedUser,
    @Query('projectId') projectId?: string,
    @Query('createdByUserId') createdByUserId?: string,
  ) {
    return this.portalService.getTickets(user.id, { projectId, createdByUserId });
  }

  @Get('portal/tickets/:ticketId')
  @ApiOperation({ summary: 'Detalle de un ticket del cliente' })
  getTicketDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ticketId') ticketId: string,
  ) {
    return this.portalService.getTicketDetail(user.id, ticketId);
  }

  @Post('portal/projects/:projectId/tickets')
  @ApiOperation({ summary: 'Crear un ticket en un proyecto' })
  @HttpCode(HttpStatus.CREATED)
  createTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
    @Body() dto: CreateTicketDto,
  ) {
    return this.portalService.createTicket(user.id, projectId, dto);
  }

  @Get('portal/ticket-categories')
  @ApiOperation({ summary: 'Listar categorías activas de tickets para el portal' })
  getTicketCategories(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getActiveTicketCategories(user.id);
  }

  @Get('portal/business-hours')
  @ApiOperation({ summary: 'Horario de atención de la organización del cliente' })
  getBusinessHours(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getBusinessHours(user.id);
  }
}
