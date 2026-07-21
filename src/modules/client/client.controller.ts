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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard, PermissionsGuard } from '../auth/guards';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { ClientService } from './client.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { CreateClientUserDto } from './dto/create-client-user.dto';
import { EditHoursTransactionDto } from './dto/edit-hours-transaction.dto';

@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations/:orgId/clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un cliente' })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateClientDto,
  ) {
    return this.clientService.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar clientes de la organizacion' })
  findAll(
    @Param('orgId') orgId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('withUsers') withUsers?: string,
  ) {
    return this.clientService.findAll(orgId, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      status,
      withUsers: withUsers === 'true',
    });
  }

  @Get(':clientId')
  @ApiOperation({ summary: 'Detalle de un cliente' })
  findById(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.findById(orgId, clientId);
  }

  @Patch(':clientId')
  @ApiOperation({ summary: 'Actualizar un cliente' })
  update(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clientService.update(orgId, clientId, dto);
  }

  @Patch(':clientId/status')
  @ApiOperation({ summary: 'Cambiar estado del cliente (ACTIVE, DISABLED, ARCHIVED)' })
  changeStatus(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { status: 'ACTIVE' | 'DISABLED' | 'ARCHIVED' },
  ) {
    return this.clientService.changeStatus(orgId, clientId, body.status);
  }

  @Delete(':clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archivar un cliente (soft-delete)' })
  remove(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.changeStatus(orgId, clientId, 'ARCHIVED');
  }

  @Post(':clientId/create-user')
  @ApiOperation({ summary: 'Crear usuario de acceso portal para un cliente' })
  @HttpCode(HttpStatus.CREATED)
  createUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: CreateClientUserDto,
  ) {
    return this.clientService.createClientUser(orgId, clientId, dto);
  }

  // ── Portal toggle ──────────────────────────────────────

  @Patch(':clientId/portal')
  @ApiOperation({ summary: 'Habilitar o deshabilitar portal de un cliente' })
  togglePortal(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.clientService.togglePortal(orgId, clientId, body.enabled);
  }

  // ── Sub-usuarios ──────────────────────────────────────

  @Post(':clientId/users')
  @ApiOperation({ summary: 'Crear sub-usuario para un cliente' })
  @HttpCode(HttpStatus.CREATED)
  createSubUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: CreateClientUserDto,
  ) {
    return this.clientService.createSubUser(orgId, clientId, dto);
  }

  @Get(':clientId/users')
  @ApiOperation({ summary: 'Listar sub-usuarios de un cliente' })
  listSubUsers(@Param('clientId') clientId: string) {
    return this.clientService.listSubUsers(clientId);
  }

  @Delete(':clientId/users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar sub-usuario de un cliente' })
  deleteSubUser(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
  ) {
    return this.clientService.deleteSubUser(orgId, clientId, userId);
  }

  @Post(':clientId/users/:userId/resend-activation')
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reenviar email de activación a un sub-usuario sin verificar' })
  resendActivation(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
  ) {
    return this.clientService.resendActivation(orgId, clientId, userId);
  }

  // ── Horas contratadas ─────────────────────────────────

  @Get(':clientId/hours')
  @ApiOperation({ summary: 'Resumen de horas contratadas del cliente (transacciones paginadas)' })
  getHoursSummary(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('movement') movement?: string,
  ) {
    return this.clientService.getHoursSummary(
      orgId,
      clientId,
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      movement,
    );
  }

  @Post(':clientId/hours')
  @ApiOperation({ summary: 'Agregar horas contratadas a un cliente' })
  @HttpCode(HttpStatus.CREATED)
  addHours(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() body: { hours: number; note?: string },
  ) {
    return this.clientService.addHours(orgId, clientId, body.hours, body.note);
  }

  @Post(':clientId/hours/:transactionId/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar (soft-delete) una transacción de horas' })
  deleteHoursTransaction(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('transactionId') transactionId: string,
    @Body() body: { reason: string; deletedById: string },
  ) {
    return this.clientService.deleteHoursTransaction(orgId, clientId, transactionId, body.deletedById, body.reason);
  }

  @Post(':clientId/hours/:transactionId/edit')
  @Permissions('manage:projects')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Editar horas/tarifa de una transacción histórica (solo USAGE/LOAN)' })
  editHoursTransaction(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('transactionId') transactionId: string,
    @Body() dto: EditHoursTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientService.editHoursTransaction(orgId, clientId, transactionId, dto, user.id);
  }

  @Post(':clientId/hours/sync')
  @ApiOperation({ summary: 'Sincronizar horas de tareas SUPPORT completadas no procesadas' })
  syncHours(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.syncMissedHours(orgId, clientId);
  }
}
