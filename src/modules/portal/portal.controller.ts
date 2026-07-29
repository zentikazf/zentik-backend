import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
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

  // ── Invoices endpoint (Portal, H8f) ──────────────────────

  @Get('portal/invoices')
  @ApiOperation({ summary: 'Facturas de horas emitidas al cliente (SENT/PAID/anuladas)' })
  getMyInvoices(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getMyInvoices(user.id);
  }

  // #23: Variables de facturación del cliente (solo valores comerciales, scopeado por user.clientId).
  @Get('portal/variables')
  @ApiOperation({ summary: 'Variables de facturación del cliente (valores comerciales guardados)' })
  getMyVariables(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getMyVariables(user.id);
  }

  // Ruta de 3 segmentos (invoices/:cycleId/pdf) → no colisiona con GET portal/invoices.
  // `@Res({ passthrough: false })` bypassea el interceptor global (igual que el PDF admin de H8e).
  @Get('portal/invoices/:cycleId/pdf')
  @ApiOperation({ summary: 'Descargar el PDF de una factura del cliente' })
  downloadMyInvoice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('cycleId') cycleId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    return this.portalService.downloadMyInvoice(user.id, cycleId, res);
  }

  // H9b: descarga del PDF de una nota de crédito del cliente. Ruta de 3 segmentos con estático inicial
  // 'credit-notes' → no colisiona con portal/invoices/... `@Res({ passthrough: false })` bypassea el interceptor.
  @Get('portal/credit-notes/:creditNoteId/pdf')
  @ApiOperation({ summary: 'Descargar el PDF de una nota de crédito del cliente' })
  downloadMyCreditNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('creditNoteId') creditNoteId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    return this.portalService.downloadMyCreditNote(user.id, creditNoteId, res);
  }

  // ── Ticket endpoints (Portal) ─────────────────────────────

  @Get('portal/tickets')
  @ApiOperation({
    summary: 'Listar todos los tickets del cliente autenticado (filtrado/paginado client-side)',
  })
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

  @Get('portal/projects/:projectId/documents')
  @ApiOperation({ summary: 'Listar documentos del proyecto compartidos con el cliente' })
  getProjectDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.portalService.getProjectDocuments(user.id, projectId);
  }

  @Get('portal/documents/:fileId/download')
  @ApiOperation({ summary: 'Descargar un documento compartido (registra evento)' })
  downloadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.portalService.downloadDocument(user.id, fileId, req, res);
  }

  // ── Client Documents (general, no por proyecto) ──────────

  @Get('portal/client-documents')
  @ApiOperation({ summary: 'Documentos compartidos al cliente (no por proyecto)' })
  getClientDocuments(@CurrentUser() user: AuthenticatedUser) {
    return this.portalService.getClientDocuments(user.id);
  }

  @Get('portal/client-documents/:fileId/download')
  @ApiOperation({ summary: 'Descargar un documento del cliente (registra evento)' })
  downloadClientDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('fileId') fileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.portalService.downloadClientDocument(user.id, fileId, req, res);
  }
}
