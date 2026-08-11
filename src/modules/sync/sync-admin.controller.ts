import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import {
  OnnixMappingService,
  SeedTicketTypeMappingsOrgResult,
} from './onnix-mapping.service';
import { DrainResult } from './types/outbox.types';

/**
 * Endpoint admin de sync Onnix (feature #13).
 *
 * - Ruta: POST /api/v1/admin/sync/onnix/drain (prefix global en main.ts).
 * - Guards: AuthGuard (401 sin sesión, R42) + RolesGuard restringido a roles
 *   internos (403 sin rol, R41). Mismo patrón que feature #8 (admin-mcp).
 * - `drain` llama el MISMO `processPending()` que el cron (R36) y devuelve los
 *   contadores `{ synced, failed }` (R37).
 */
@ApiTags('Admin Sync')
@ApiBearerAuth()
@Controller('admin/sync')
@UseGuards(AuthGuard, RolesGuard)
@Roles('Owner', 'Project Manager', 'Developer')
export class SyncAdminController {
  constructor(
    private readonly dispatcher: SyncDispatcherService,
    private readonly reconciliation: SyncReconciliationService,
    private readonly mapping: OnnixMappingService,
  ) {}

  @Post('onnix/drain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Drenar manualmente el outbox de sync hacia Onnix' })
  @ApiResponse({ status: 200, description: 'Resultado del drain (synced/failed)' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  drain(): Promise<DrainResult> {
    return this.dispatcher.processPending();
  }

  @Post('onnix/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconciliación v1: re-encolar failed + detectar faltantes' })
  @ApiResponse({ status: 200, description: 'Resultado de la reconciliación' })
  reconcile(): Promise<{ requeued: number; missing: number }> {
    return this.reconciliation.reconcileV1();
  }

  /**
   * Siembra los mappings de tipo de incidencia por slug (#50 R1.3/R1.4).
   * Idempotente: correrlo dos veces deja el mismo estado (2ª corrida = todo en
   * `alreadyMapped`). No recibe input: el scope son las orgs de
   * `ONNIX_SYNC_ORG_IDS` — nada que validar ni por donde inyectar.
   */
  @Post('onnix/seed-ticket-types')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sembrar los mappings de tipo de incidencia Zentik → Onnix (por slug)',
  })
  @ApiResponse({ status: 200, description: 'Resultado por organización (created/updated/alreadyMapped)' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  seedTicketTypes(): Promise<SeedTicketTypeMappingsOrgResult[]> {
    return this.mapping.seedTicketTypeMappings();
  }
}
