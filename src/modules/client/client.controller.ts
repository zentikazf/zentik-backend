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
import { DeleteHoursTransactionDto } from './dto/delete-hours-transaction.dto';
import { ChangeClientStatusDto } from './dto/change-client-status.dto';
import { TogglePortalDto } from './dto/toggle-portal.dto';
import { AddHoursDto } from './dto/add-hours.dto';
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

/**
 * #65 T1 (C1) — CRITERIO DE PERMISOS DE ESTE CONTROLLER.
 *
 * Hasta este spec el archivo tenía 17 rutas y UN solo `@Permissions` (el del edit de horas).
 * Los guards de clase engañaban: `PermissionsGuard` devuelve `true` cuando el handler no tiene
 * decorador (permissions.guard.ts:24), así que las otras 16 sólo exigían sesión válida —
 * incluidas `@Delete(':clientId')` (archiva un cliente), `POST :clientId/hours` y el borrado de
 * movimientos del ledger. Cualquier usuario autenticado, de cualquier rol, las ejecutaba.
 *
 * Los permisos se eligieron SÓLO entre los que existen de verdad (prisma/seed.ts:9-27 y
 * organization.service.ts:70-82). Inventar uno nuevo habría sido peor que no hacer nada: un
 * permiso recién creado no lo tiene ningún rol de producción, así que todos menos Owner (`*:*`)
 * pasarían a comer 403 hasta correr un backfill de roles.
 *
 *   manage:members  → alta/baja/edición del cliente y de sus usuarios de portal. El service
 *                     escribe filas `OrganizationMember` (client.service.ts:466, 584, 657): son
 *                     literalmente operaciones de membresía. Además el sidebar del frontend ya
 *                     declara toda la sección Clientes como `manage:members` (sidebar.tsx:42), y
 *                     el gemelo exacto del resend-activation ya lo usa
 *                     (organization.controller.ts:142) — el frontend dispara las dos URLs desde
 *                     UN mismo botón, así que divergir garantizaba un 403 intermitente.
 *   read:members    → las lecturas de esa misma superficie (`manage:members` las cubre por el
 *                     fallback read→manage del guard, permissions.guard.ts:45-51).
 *   read:billing    → el ledger de horas. Devuelve tarifa hora, montos y facturable
 *                     (client.service.ts:766-771): es información comercial, y es el mismo
 *                     permiso que usa client-billing.controller para todo lo que muestra plata
 *                     del cliente. NO se usó `read:projects` acá a propósito: el rol `Cliente`
 *                     —el usuario EXTERNO del portal— lo recibe en cada alta
 *                     (client.service.ts:1410), así que habría sido un decorador decorativo
 *                     puesto sobre las tarifas.
 *   manage:projects → las mutaciones del ledger. Es el ancla que ya existía en el edit, y con la
 *                     que el frontend gatea el lápiz (`canEditHours`, tiempo/page.tsx:201).
 *   read:projects   → SÓLO el listado de clientes. Es deliberadamente el más laxo: tres
 *                     pantallas de staff (projects, tickets, dashboard) lo llaman nada más que
 *                     para poblar un dropdown de filtro, y con `.catch(() => {})` — con un
 *                     permiso más fuerte ese filtro quedaba vacío para Developer/QA/Designer/
 *                     DevOps/Soporte SIN ningún error visible. No corta al rol `Cliente`, que
 *                     tampoco cortaba antes: cerrarlo de verdad es tenencia, no permisos.
 *
 * `POST :clientId/hours/sync` queda SIN decorador a propósito: es un tombstone que lanza 410
 * antes de tocar nada (H1). Ponerle permiso sólo convertiría un 410 que explica por qué murió
 * el endpoint en un 403 mudo.
 *
 * ⚠️ ALCANCE — esto agrega AUTORIZACIÓN, no TENENCIA. El `:orgId` de la URL se sigue sin validar
 * contra las organizaciones del usuario, y `AuthGuard` resuelve los permisos con
 * `user.organizationMembers[0]` (auth.guard.ts:95, sin `orderBy`): para un usuario multi-org el
 * rol evaluado puede no ser el de la organización del path. Las dos cosas son PRE-EXISTENTES y
 * app-wide, están fuera del alcance declarado de #65 y siguen en el backlog como
 * OrgMembershipGuard. Un permiso mal evaluado sigue siendo estrictamente mejor que ninguno,
 * pero este comentario existe para que nadie lea estos decoradores como "cerrado".
 */
@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionsGuard)
@Controller('organizations/:orgId/clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Crear un cliente' })
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateClientDto,
  ) {
    return this.clientService.create(orgId, dto);
  }

  @Get()
  @Permissions('read:projects')
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
  @Permissions('read:members')
  @ApiOperation({ summary: 'Detalle de un cliente' })
  findById(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.clientService.findById(orgId, clientId);
  }

  @Patch(':clientId')
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Actualizar un cliente' })
  update(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clientService.update(orgId, clientId, dto);
  }

  @Patch(':clientId/status')
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Cambiar estado del cliente (ACTIVE, DISABLED, ARCHIVED)' })
  changeStatus(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: ChangeClientStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientService.changeStatus(orgId, clientId, dto.status, user.id);
  }

  @Delete(':clientId')
  @Permissions('manage:members')
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
  @Permissions('manage:members')
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
  @Permissions('manage:members')
  @ApiOperation({ summary: 'Habilitar o deshabilitar portal de un cliente' })
  togglePortal(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: TogglePortalDto,
  ) {
    return this.clientService.togglePortal(orgId, clientId, dto.enabled);
  }

  // ── Sub-usuarios ──────────────────────────────────────

  @Post(':clientId/users')
  @Permissions('manage:members')
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
  @Permissions('read:members')
  @ApiOperation({ summary: 'Listar sub-usuarios de un cliente' })
  listSubUsers(@Param('clientId') clientId: string) {
    return this.clientService.listSubUsers(clientId);
  }

  @Delete(':clientId/users/:userId')
  @Permissions('manage:members')
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
  @Permissions('manage:members')
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
  @Permissions('read:billing')
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
  @Permissions('manage:projects')
  @ApiOperation({ summary: 'Agregar horas contratadas a un cliente' })
  @HttpCode(HttpStatus.CREATED)
  addHours(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: AddHoursDto,
  ) {
    return this.clientService.addHours(orgId, clientId, dto.hours, dto.note);
  }

  // #65 T2 (C2.1) — el delete quedó igual que el edit de doce líneas más abajo, que ya lo
  // hacía bien: permiso explícito, DTO validado y el ACTOR salido de la sesión.
  //
  // Lo que había: sin @Permissions (el guard deja pasar cuando no hay decorador,
  // permissions.guard.ts:24), `@Body() body: { reason: string; deletedById: string }` como tipo
  // inline —o sea sin validar— y `deletedById` tomado del BODY. Ese último era el peor de los
  // tres: cualquiera podía firmar el borrado de un movimiento del ledger con el id de otra
  // persona, así que el único registro de quién sacó horas de una factura era un dato que el
  // atacante elegía. Una auditoría que miente es peor que no tenerla.
  //
  // El `deletedById` del DTO se acepta y se DESCARTA a propósito (ver DeleteHoursTransactionDto):
  // `forbidNonWhitelisted: true` haría 400 con el frontend viejo, que todavía lo manda.
  @Post(':clientId/hours/:transactionId/delete')
  @Permissions('manage:projects')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar (soft-delete) una transacción de horas' })
  deleteHoursTransaction(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Param('transactionId') transactionId: string,
    @Body() dto: DeleteHoursTransactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.clientService.deleteHoursTransaction(orgId, clientId, transactionId, user.id, dto.reason);
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
