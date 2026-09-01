import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ClientBillingService } from './client-billing.service';
import { ClientBillingPdfService } from './client-billing-pdf.service';
import { CloseCycleDto } from './dto/close-cycle.dto';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { PreviewCycleDto } from './dto/preview-cycle.dto';
import { ReopenCycleDto } from './dto/reopen-cycle.dto';
import { WriteOffCycleDto } from './dto/write-off-cycle.dto';
import { UpdateCycleDto } from './dto/update-cycle.dto';

@ApiTags('Client Billing')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations/:orgId/clients/:clientId/billing')
export class ClientBillingController {
  constructor(
    private readonly service: ClientBillingService,
    private readonly pdfService: ClientBillingPdfService,
  ) {}

  @Get('cycles')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Listar meses del cliente con estado + total facturable' })
  listCycles(@Param('orgId') orgId: string, @Param('clientId') clientId: string) {
    return this.service.listCycles(orgId, clientId);
  }

  @Get('cycles/:period')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Card de armado del período (Soporte | Proyecto | Interno)' })
  getBuilder(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
  ) {
    return this.service.getBuilder(orgId, clientId, period);
  }

  // Ruta de 3 segmentos (cycles/:cycleId/transactions) → NO colisiona con el
  // GET cycles/:period (2 segmentos): distinta profundidad de path.
  @Get('cycles/:cycleId/transactions')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Líneas facturadas de un ciclo (snapshot congelado)' })
  getCycleTransactions(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
  ) {
    return this.service.getCycleTransactions(orgId, clientId, cycleId);
  }

  // H8e: descarga del PDF de la factura. Ruta de 3 segmentos (cycles/:cycleId/pdf) → no colisiona
  // con GET cycles/:period (2 segmentos). `@Res({ passthrough: false })` bypassea el interceptor
  // global (mismo patrón que el export CSV de tickets, ticket.controller.ts).
  @Get('cycles/:cycleId/pdf')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Descargar la factura del ciclo como PDF' })
  async downloadInvoicePdf(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdfService.generateInvoicePdf(orgId, clientId, cycleId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  // H8d: rutas period-less (el período/meses viajan en el body). Declaradas ANTES de las rutas
  // con :param para que el segmento estático gane el match.
  @Post('cycles/preview')
  @Permissions('read:billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dry-run: conjunto facturable agrupado por mes-de-trabajo, sin emitir' })
  previewCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: PreviewCycleDto,
  ) {
    return this.service.previewCycle(orgId, clientId, dto);
  }

  @Post('cycles/emit')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emitir factura (mes individual | acumulada | parcial): crea ciclo Borrador y estampa' })
  emitCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: CloseCycleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.closeCycle(orgId, clientId, dto.period ?? '', dto, user);
  }

  // Alias legacy: el CloseCycleDialog viejo cierra un mes por path (mode=MES implícito).
  @Post('cycles/:period/close')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Cerrar el período: crea ciclo Borrador, estampa y congela snapshot' })
  closeCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('period') period: string,
    @Body() dto: CloseCycleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.closeCycle(orgId, clientId, period, { ...dto, mode: 'MES', period }, user);
  }

  @Post('cycles/:cycleId/reopen')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular un ciclo con motivo obligatorio (libera estampados + CANCELLED, keep-data)' })
  reopenCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Body() dto: ReopenCycleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.reopenCycle(orgId, clientId, cycleId, dto, user);
  }

  // #65 T12 (A1.4): endpoint propio y no un valor más del `@IsIn` del PATCH genérico, porque
  // cerrar sin cobro exige MOTIVO. En el PATCH el motivo habría quedado opcional, y una factura
  // que dejó de cobrarse sin explicación no se puede auditar. Misma forma que `reopen`, que es
  // la convención del repo para las operaciones con motivo obligatorio.
  @Post('cycles/:cycleId/write-off')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar una factura SIN COBRO (SENT → WRITTEN_OFF, motivo obligatorio, no sella paidAt)' })
  writeOffCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Body() dto: WriteOffCycleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.writeOffCycle(orgId, clientId, cycleId, dto, user);
  }

  @Patch('cycles/:cycleId')
  @Permissions('manage:billing')
  @ApiOperation({ summary: 'Transición de estado de la factura (Borrador→Enviada→Cobrada) / notas' })
  updateCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Body() dto: UpdateCycleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updateCycle(orgId, clientId, cycleId, dto, user);
  }

  // ── H9b: Notas de crédito ────────────────────────────────────────────────

  // Ruta de 4 segmentos (cycles/:cycleId/credit-notes/preview) → declarada ANTES del POST de 3
  // segmentos para que el segmento estático 'preview' gane el match.
  @Post('cycles/:cycleId/credit-notes/preview')
  @Permissions('read:billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dry-run de una nota de crédito (montos negativos), sin emitir' })
  previewCreditNote(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Body() dto: CreateCreditNoteDto,
  ) {
    return this.service.previewCreditNote(orgId, clientId, cycleId, dto);
  }

  @Post('cycles/:cycleId/credit-notes')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emitir una nota de crédito sobre una factura SENT/PAID' })
  emitCreditNote(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @Body() dto: CreateCreditNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.emitCreditNote(orgId, clientId, cycleId, dto, user);
  }

  @Get('cycles/:cycleId/credit-notes')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Notas de crédito emitidas sobre un ciclo (banner staff)' })
  getCreditNotes(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
  ) {
    return this.service.getCreditNotes(orgId, clientId, cycleId);
  }

  // Ruta de 3 segmentos con estático inicial 'credit-notes' → no colisiona con cycles/:cycleId/...
  @Get('credit-notes/:creditNoteId/pdf')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Descargar la nota de crédito como PDF' })
  async downloadCreditNotePdf(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('creditNoteId') creditNoteId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdfService.generateCreditNotePdf(orgId, clientId, creditNoteId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }
}
