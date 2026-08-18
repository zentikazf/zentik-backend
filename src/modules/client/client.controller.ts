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
import { AppException } from '../../common/filters/app-exception';

/**
 * #57 — Convierte un query param de paginacion a entero positivo, o `undefined` si es basura.
 *
 * El problema que arregla: `parseInt('abc', 10)` devuelve NaN, y NaN es venenoso porque
 * SOBREVIVE al clamp defensivo del service (`Math.min(Math.max(1, NaN), 500)` sigue siendo NaN).
 * Prisma terminaba recibiendo `take: NaN` y la pantalla reventaba con un 500.
 *
 * Devolver `undefined` en vez de NaN hace que entre el valor por defecto de la firma del
 * service (page = 1, limit = 20 en getHoursSummary; page = 1, limit = 50 en findAll), que es el
 * comportamiento correcto para un input invalido. Los clamps del service NO se tocan: siguen ahi
 * como defensa en profundidad para cualquier otro llamador que no pase por este borde.
 *
 * ORDEN IMPORTANTE: se TRUNCA primero y se compara despues. Al reves, `0.5 > 0` daba true y
 * `Math.trunc(0.5)` devolvia 0 — justo el valor que este helper promete descartar. El sintoma
 * visible era que `?limit=0` caia al default (20 filas) pero `?limit=0.5` devolvia 1 fila: dos
 * basuras equivalentes con resultados distintos.
 *
 * Se descartan 0, negativos, NaN e Infinity: ninguno es una pagina o un tamanio de pagina valido.
 *
 * NO hay paridad con el `parseInt(raw, 10)` que habia antes, y no se busca: `Number` lee el string
 * COMPLETO en vez de cortar en el primer caracter no numerico. Comportamiento REAL de hoy:
 *   - `'1e3'`   → 1000   (parseInt cortaba en la 'e' y daba 1)
 *   - `'0x10'`  → 16     (parseInt con base 10 daba 0 ⇒ default)
 *   - `'10abc'` → undefined ⇒ default (parseInt daba 10)
 *   - `'1.9'`   → 1      (truncado; parseInt tambien daba 1)
 *   - `'  20 '` → 20     (Number ignora el espacio en blanco de los bordes)
 *   - `['10','20']` (Express entrega un ARRAY cuando el param viene repetido, `?limit=10&limit=20`)
 *     → `Number([...])` es NaN ⇒ undefined ⇒ default. La firma dice `string`, pero en runtime
 *     Express puede mandar un array: rechazarlo es la lectura segura de un input ambiguo.
 * Rechazar de mas es aceptable aca: el peor caso de un input dudoso es caer al default, no un 500.
 */
function parsePaginationParam(raw?: string): number | undefined {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

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
      // #57: mismo saneo que getHoursSummary. Antes era `Number(page)` crudo, y `Number('abc')`
      // es NaN: aca es PEOR que en getHoursSummary porque el service de findAll no tiene ningun
      // clamp — `params.limit ?? 50` no atrapa NaN (`??` solo cubre null/undefined), asi que
      // `take: NaN` llegaba a Prisma ("Argument `take` is missing" ⇒ 500) sin segunda defensa.
      page: parsePaginationParam(page),
      limit: parsePaginationParam(limit),
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
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientService.changeStatus(orgId, clientId, body.status, user.id);
  }

  @Delete(':clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archivar un cliente (soft-delete)' })
  remove(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientService.changeStatus(orgId, clientId, 'ARCHIVED', user.id);
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
      parsePaginationParam(page),
      parsePaginationParam(limit),
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

  // DEPRECATED — H1 OBJ-2 (candado de emergencia). syncMissedHours inventaba horas fantasma:
  // usaba estimatedHours*60 o, sin estimación, la ANTIGÜEDAD de la tarea en minutos
  // (Date.now()-createdAt, client.service.ts:996), pudiendo generar cientos de horas falsas.
  // Se congela como tombstone 410 (no 404) para cortar deep-links/curl/Postman. NO se elimina el
  // cuerpo de syncMissedHours (KEEP-CODE); el motor de horas correcto se rediseña en H2..H9.
  @Post(':clientId/hours/sync')
  @ApiOperation({
    summary: 'DEPRECATED — devuelve 410 Gone. El sync de horas fue congelado (H1): inventaba horas fantasma.',
    deprecated: true,
  })
  syncHours(): never {
    throw new AppException(
      'El sync de horas fue deshabilitado: generaba horas inexactas. El descuento correcto ocurre al confirmar tiempo (time_entry.confirmed).',
      'HOURS_SYNC_DEPRECATED',
      HttpStatus.GONE,
      { replacement: 'timer + time_entry.confirmed (motor de horas H2..H9)' },
    );
  }
}
