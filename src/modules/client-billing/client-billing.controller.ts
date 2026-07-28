import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ClientBillingService } from './client-billing.service';
import { CloseCycleDto } from './dto/close-cycle.dto';
import { PreviewCycleDto } from './dto/preview-cycle.dto';
import { ReopenCycleDto } from './dto/reopen-cycle.dto';
import { UpdateCycleDto } from './dto/update-cycle.dto';

@ApiTags('Client Billing')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations/:orgId/clients/:clientId/billing')
export class ClientBillingController {
  constructor(private readonly service: ClientBillingService) {}

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
}
