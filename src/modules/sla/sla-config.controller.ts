import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/request.interface';
import { AuthGuard, RolesGuard } from '../auth/guards';
import { ContractPackageService } from './contract-package.service';
import {
  CriticalityConfigService,
  parseCriticality,
  requireCriticality,
} from './criticality-config.service';
import { SlaContractService } from './sla-contract.service';
import { SlaPolicyService } from './sla-policy.service';
import { SlaSeedService } from './sla-seed.service';
import { TicketTypeAvailabilityService } from './ticket-type-availability.service';
import { TicketTypeService } from './ticket-type.service';
import {
  ApplyContractPackageDto,
  AssignSlaDto,
  AvailableTicketTypesQueryDto,
  CreateContractPackageDto,
  CreateSlaPolicyDto,
  CreateTicketTypeDto,
  PreviewContractPackageDto,
  UpdateContractPackageDto,
  UpdateCriticalityConfigDto,
  UpdateSlaPolicyDto,
  UpdateTicketTypeDto,
  UpsertContractPackageItemsDto,
  UpsertProjectContractDto,
} from './dto';

/**
 * Configuración del motor de SLA (feature #42 — Fase 1).
 *
 * Guards: `AuthGuard` + `RolesGuard` con `Owner` / `Project Manager` (molde
 * `admin-mcp.controller.ts`). Es configuración de negocio: NO la tocan clientes
 * del portal ni developers.
 *
 * Sin lógica de negocio acá: el controller solo rutea y pasa el `userId` del
 * usuario autenticado para la trazabilidad de los eventos de dominio.
 */
@ApiTags('SLA Config')
@ApiBearerAuth()
@Controller('organizations/:orgId')
@UseGuards(AuthGuard, RolesGuard)
@Roles('Owner', 'Project Manager')
export class SlaConfigController {
  constructor(
    private readonly policies: SlaPolicyService,
    private readonly types: TicketTypeService,
    private readonly contracts: SlaContractService,
    private readonly seed: SlaSeedService,
    private readonly criticalities: CriticalityConfigService,
    private readonly availability: TicketTypeAvailabilityService,
    private readonly packages: ContractPackageService,
  ) {}

  // ── Políticas SLA ────────────────────────────────────────────────────────

  @Get('sla-policies')
  @ApiOperation({ summary: 'Listar políticas SLA de la organización' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listPolicies(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.policies.list(orgId, includeInactive === 'true');
  }

  @Post('sla-policies')
  @ApiOperation({ summary: 'Crear una política SLA con nombre' })
  createPolicy(
    @Param('orgId') orgId: string,
    @Body() dto: CreateSlaPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.policies.create(orgId, dto, user.id);
  }

  @Patch('sla-policies/:policyId')
  @ApiOperation({ summary: 'Editar una política SLA' })
  updatePolicy(
    @Param('orgId') orgId: string,
    @Param('policyId') policyId: string,
    @Body() dto: UpdateSlaPolicyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.policies.update(orgId, policyId, dto, user.id);
  }

  @Delete('sla-policies/:policyId')
  @ApiOperation({ summary: 'Desactivar una política SLA (baja lógica)' })
  deactivatePolicy(
    @Param('orgId') orgId: string,
    @Param('policyId') policyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.policies.deactivate(orgId, policyId, user.id);
  }

  // ── Tipos de solicitud ───────────────────────────────────────────────────

  // LECTURA del catálogo: incluye Developer. El @Roles de la clase es Owner/PM
  // (escritura), pero `PATCH tickets/:id/classification` permite Developer — sin
  // este override, un Developer podría reclasificar pero no listar los tipos para
  // elegir uno (403 y selector muerto). `getAllAndOverride` hace que el decorador
  // de método pise al de la clase. Escritura de tipos sigue siendo Owner/PM.
  @Get('ticket-types')
  @Roles('Owner', 'Project Manager', 'Developer')
  @ApiOperation({ summary: 'Listar tipos de solicitud (plano, ordenado por path del árbol)' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listTypes(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.types.list(orgId, includeInactive === 'true');
  }

  // #42 Fase 3: la MISMA lectura, anidada. Mismo `@Roles` que `GET ticket-types`
  // (incluye Developer): es el catálogo que puebla el selector de reclasificación.
  @Get('ticket-types/tree')
  @Roles('Owner', 'Project Manager', 'Developer')
  @ApiOperation({ summary: 'Árbol de tipos de solicitud (jerarquía anidada, `children[]`)' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listTypeTree(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.types.getTree(orgId, includeInactive === 'true');
  }

  @Post('ticket-types')
  @ApiOperation({ summary: 'Crear un tipo de solicitud' })
  createType(@Param('orgId') orgId: string, @Body() dto: CreateTicketTypeDto) {
    return this.types.create(orgId, dto);
  }

  @Patch('ticket-types/:typeId')
  @ApiOperation({ summary: 'Editar un tipo de solicitud' })
  updateType(
    @Param('orgId') orgId: string,
    @Param('typeId') typeId: string,
    @Body() dto: UpdateTicketTypeDto,
  ) {
    return this.types.update(orgId, typeId, dto);
  }

  @Delete('ticket-types/:typeId')
  @ApiOperation({
    summary: 'Desactivar un tipo de solicitud y TODA su rama (baja lógica en cascada)',
    description: 'Devuelve `{ deactivated }`: cuántos tipos se apagaron, incluido el propio.',
  })
  deactivateType(@Param('orgId') orgId: string, @Param('typeId') typeId: string) {
    return this.types.deactivate(orgId, typeId);
  }

  // ── Criticidades: presentación y visibilidad (Fase 2) ────────────────────

  // LECTURA: incluye Developer por el mismo motivo que `GET ticket-types` — el
  // diálogo de reclasificación necesita las criticidades para poblar el selector.
  @Get('criticality-configs')
  @Roles('Owner', 'Project Manager', 'Developer')
  @ApiOperation({ summary: 'Config de criticidades de la organización (etiqueta, visibilidad, orden)' })
  listCriticalityConfigs(@Param('orgId') orgId: string) {
    return this.criticalities.list(orgId);
  }

  @Patch('criticality-configs/:criticality')
  @ApiOperation({ summary: 'Editar etiqueta / visibilidad / orden / default de una criticidad' })
  upsertCriticalityConfig(
    @Param('orgId') orgId: string,
    @Param('criticality') criticality: string,
    @Body() dto: UpdateCriticalityConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // El path param NO pasa por el ValidationPipe global: se valida acá contra el enum.
    return this.criticalities.upsert(orgId, requireCriticality(criticality), dto, user.id);
  }

  // ── Contratos por proyecto ───────────────────────────────────────────────

  @Get('projects/:projectId/sla-contracts')
  @ApiOperation({ summary: 'Matriz tipo → política del proyecto (+ cobertura)' })
  getProjectContracts(@Param('orgId') orgId: string, @Param('projectId') projectId: string) {
    return this.contracts.getByProject(orgId, projectId);
  }

  @Put('projects/:projectId/sla-contracts')
  @ApiOperation({ summary: 'Upsert de la matriz tipo → política del proyecto' })
  upsertProjectContracts(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() dto: UpsertProjectContractDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contracts.upsertForProject(orgId, projectId, dto, user.id);
  }

  /**
   * Vista de STAFF del mismo dato que consume el portal.
   *
   * `audience: 'STAFF'` (#48 R2.2, call site 3): NO filtra por `clientVisible`.
   * El equipo ve el árbol completo, carpetas incluidas — puede tipificar un
   * ticket con un tipo que el cliente no puede elegir.
   */
  @Get('projects/:projectId/available-ticket-types')
  @ApiOperation({
    summary:
      'Tipos disponibles del proyecto para STAFF (contratados; permisivo + fallback si no hay contratos). No oculta carpetas.',
  })
  @ApiQuery({ name: 'criticality', required: false, enum: ['HIGH', 'MEDIUM', 'LOW'] })
  getAvailableTicketTypes(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: AvailableTicketTypesQueryDto,
  ) {
    return this.availability.getAvailableTypes(orgId, projectId, {
      criticality: parseCriticality(query.criticality),
      audience: 'STAFF',
    });
  }

  // ── Paquetes de contratos default (#58) ──────────────────────────────────

  @Get('sla-packages')
  @ApiOperation({
    summary: 'Listar paquetes de contratos (con el count de "usado en N proyectos")',
  })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listPackages(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.packages.list(orgId, includeInactive === 'true');
  }

  @Post('sla-packages')
  @ApiOperation({ summary: 'Crear un paquete de contratos (nace vacío)' })
  createPackage(
    @Param('orgId') orgId: string,
    @Body() dto: CreateContractPackageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packages.create(orgId, dto, user.id);
  }

  @Get('sla-packages/:packageId')
  @ApiOperation({
    summary: 'Paquete + catálogo COMPLETO de tipos con su asignación (mismo shape que la matriz)',
  })
  getPackage(@Param('orgId') orgId: string, @Param('packageId') packageId: string) {
    return this.packages.getById(orgId, packageId);
  }

  @Patch('sla-packages/:packageId')
  @ApiOperation({ summary: 'Renombrar / anotar / archivar un paquete (no toca sus ítems)' })
  updatePackage(
    @Param('orgId') orgId: string,
    @Param('packageId') packageId: string,
    @Body() dto: UpdateContractPackageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packages.update(orgId, packageId, dto, user.id);
  }

  @Put('sla-packages/:packageId/items')
  @ApiOperation({
    summary: 'Upsert de los ítems del paquete (isActive:false BORRA la fila; lo omitido no se toca)',
  })
  upsertPackageItems(
    @Param('orgId') orgId: string,
    @Param('packageId') packageId: string,
    @Body() dto: UpsertContractPackageItemsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packages.upsertItems(orgId, packageId, dto, user.id);
  }

  @Post('projects/:projectId/sla-contracts/apply-package/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview (dry-run) de aplicar un paquete: nuevos / ya iguales / distintos / omitidos',
  })
  previewContractPackage(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() dto: PreviewContractPackageDto,
  ) {
    return this.packages.preview(orgId, projectId, dto.packageId);
  }

  /**
   * Un solo endpoint para "escribir contratos + registrar la aplicación": el
   * front no arma la operación con un PUT y un POST por separado (#58 R4.1).
   */
  @Post('projects/:projectId/sla-contracts/apply-package')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aplicar un paquete al proyecto (solo pisa lo tildado; nunca apaga lo no mencionado)',
  })
  applyContractPackage(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() dto: ApplyContractPackageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.packages.apply(orgId, projectId, dto, user.id);
  }

  @Patch('projects/:projectId/sla-policy')
  @ApiOperation({ summary: 'Asignar el SLA propio del proyecto (null desasigna)' })
  assignProjectPolicy(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() dto: AssignSlaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contracts.assignProjectPolicy(orgId, projectId, dto, user.id);
  }

  @Patch('clients/:clientId/sla-policy')
  @ApiOperation({ summary: 'Asignar el SLA default del cliente (null desasigna)' })
  assignClientPolicy(
    @Param('orgId') orgId: string,
    @Param('clientId') clientId: string,
    @Body() dto: AssignSlaDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contracts.assignClientPolicy(orgId, clientId, dto, user.id);
  }

  // ── Cobertura / seed / readiness ─────────────────────────────────────────

  @Get('sla-coverage')
  @ApiOperation({ summary: 'Cobertura global de contratos (proyectos × tipos sin contrato)' })
  getCoverage(@Param('orgId') orgId: string) {
    return this.contracts.getCoverage(orgId);
  }

  @Post('sla-seed/import-current')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Importar la configuración SLA actual (idempotente, no destructivo)',
  })
  importCurrentConfig(@Param('orgId') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.seed.importCurrentConfig(orgId, user.id);
  }

  @Get('sla-readiness')
  @ApiOperation({ summary: '¿Se puede activar la cascada? (requiere política "Estándar")' })
  getReadiness(@Param('orgId') orgId: string) {
    return this.seed.getReadiness(orgId);
  }
}
