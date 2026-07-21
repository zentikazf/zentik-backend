import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { InvoiceService } from './billing.service';
import { UpdateInvoiceDto } from './dto';
import { AppException } from '../../common/filters/app-exception';

@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller()
export class BillingController {
  constructor(private readonly invoiceService: InvoiceService) {}

  // DEPRECATED — feature #27 reemplaza la facturación por proyecto por el cierre de ciclo por cliente.
  // El handler se mantiene como tombstone 410 (no 404) para cortar deep-links/bookmarks que intenten
  // generar. NO se elimina el histórico Invoice/InvoiceItem (KEEP-DATA); los readers siguen leyéndolo.
  @Post('projects/:projectId/invoices')
  @ApiOperation({
    summary: 'DEPRECATED — devuelve 410 Gone. Facturación por proyecto reemplazada por cierre de ciclo por cliente',
    deprecated: true,
  })
  generate(): never {
    throw new AppException(
      'La facturación por proyecto fue deprecada. Usá el cierre de ciclo por cliente.',
      'PROJECT_INVOICING_DEPRECATED',
      HttpStatus.GONE,
    );
  }

  @Get('projects/:projectId/invoices')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Listar facturas de un proyecto' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listByProject(
    @Param('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.invoiceService.listByProject(
      projectId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Obtener detalle de una factura' })
  async getById(@Param('id') id: string) {
    return this.invoiceService.getById(id);
  }

  @Patch('invoices/:id')
  @ApiOperation({ summary: 'Actualizar una factura' })
  async update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoiceService.update(id, dto);
  }

  @Post('invoices/:id/send')
  @ApiOperation({ summary: 'Enviar factura al cliente' })
  async send(@Param('id') id: string) {
    return this.invoiceService.send(id);
  }

  @Patch('invoices/:id/mark-paid')
  @ApiOperation({ summary: 'Marcar factura como pagada' })
  async markAsPaid(@Param('id') id: string) {
    return this.invoiceService.markAsPaid(id);
  }

  @Get('invoices/:id/pdf')
  @ApiOperation({ summary: 'Generar PDF de la factura' })
  async generatePdf(@Param('id') id: string) {
    return this.invoiceService.generatePdf(id);
  }

  @Get('organizations/:orgId/billing/summary')
  @Permissions('read:billing')
  @ApiOperation({ summary: 'Resumen de facturacion de la organizacion' })
  async getBillingSummary(@Param('orgId') orgId: string) {
    return this.invoiceService.getBillingSummary(orgId);
  }
}
