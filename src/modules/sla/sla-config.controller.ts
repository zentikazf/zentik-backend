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
import { SlaContractService } from './sla-contract.service';
import { SlaPolicyService } from './sla-policy.service';
import { SlaSeedService } from './sla-seed.service';
import { TicketTypeService } from './ticket-type.service';
import {
  AssignSlaDto,
  CreateSlaPolicyDto,
  CreateTicketTypeDto,
  UpdateSlaPolicyDto,
  UpdateTicketTypeDto,
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

  @Get('ticket-types')
  @ApiOperation({ summary: 'Listar tipos de solicitud' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  listTypes(@Param('orgId') orgId: string, @Query('includeInactive') includeInactive?: string) {
    return this.types.list(orgId, includeInactive === 'true');
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
  @ApiOperation({ summary: 'Desactivar un tipo de solicitud (baja lógica)' })
  deactivateType(@Param('orgId') orgId: string, @Param('typeId') typeId: string) {
    return this.types.deactivate(orgId, typeId);
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
