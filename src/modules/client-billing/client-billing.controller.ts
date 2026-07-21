import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ClientBillingService } from './client-billing.service';
import { CloseCycleDto } from './dto/close-cycle.dto';
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
    return this.service.closeCycle(orgId, clientId, period, dto, user);
  }

  @Post('cycles/:cycleId/reopen')
  @Permissions('manage:billing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reabrir un ciclo (libera estampados + CANCELLED, keep-data)' })
  reopenCycle(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('cycleId') cycleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.reopenCycle(orgId, clientId, cycleId, user);
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
