import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
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
import { OutboxService } from './outbox.service';
import { RequeueFailedDto } from './dto/requeue.dto';
import { DrainResult } from './types/outbox.types';

/**
 * Respuesta del drain manual (#51 FIX A). Es `DrainResult` mas UNA bandera:
 * `skipped: true` significa "no se ejecuto nada porque ya habia un drenado en
 * vuelo en este proceso". Solo aparece en ese caso — en el camino normal el body
 * sigue siendo exactamente `{ synced, failed }` (+ `dryRun`), sin cambiar el
 * contrato que ya consumen los clientes de #13.
 */
export interface DrainResponse extends DrainResult {
  skipped?: boolean;
}

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
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Drenado manual. Nunca arranca un segundo drenado en paralelo (#51 FIX A): si
   * ya hay uno en vuelo en este proceso (cron, drain-on-enqueue u otro click en el
   * boton), devuelve `{ synced: 0, failed: 0, skipped: true }` SIN llamar a
   * `processPending`.
   *
   * Por que 200 con `skipped` y no un 409: la peticion no fallo ni es un conflicto
   * que el operador tenga que resolver — el trabajo que venia a pedir se esta
   * haciendo AHORA MISMO, y el drenado en vuelo procesa la misma cola (con su
   * propio seguimiento agendado si queda trabajo). Un 409 obligaria a cada script
   * de operacion/monitoreo a tratar el caso normal "clickeaste dos veces" como
   * error, con reintentos que solo pueden empeorar el solapamiento. Los ceros son
   * honestos (este llamado no sincronizo nada) y `skipped` lo distingue del "no
   * habia nada que hacer", que es el otro resultado con ceros.
   */
  @Post('onnix/drain')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Drenar manualmente el outbox de sync hacia Onnix',
    description:
      'Si ya hay un drenado en vuelo NO arranca otro: responde 200 con ' +
      '{ synced: 0, failed: 0, skipped: true } (el drenado en curso ya esta ' +
      'procesando la misma cola).',
  })
  @ApiResponse({
    status: 200,
    description:
      'Resultado del drain (synced/failed), o { synced: 0, failed: 0, skipped: true } ' +
      'si ya habia un drenado en vuelo',
  })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  drain(): Promise<DrainResponse> {
    if (this.dispatcher.isDraining()) {
      return Promise.resolve({ synced: 0, failed: 0, skipped: true });
    }
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
   * Recuperacion manual de la DLQ (#51 R3, D4). Es el PRERREQUISITO del rollout:
   * #50 R5.3 manda validar en prod con `ONNIX_SYNC_DRY_RUN=true`, y todo lo que se
   * marca `failed` en esa ventana es simulacro sano — sin este endpoint la unica
   * forma de recuperarlo seria un UPDATE a mano contra la DB de produccion.
   *
   * Delega la resolucion de filtros en `OutboxService` (repositorio de su tabla):
   * el controller no arma queries. Solo orquesta resolver → re-encolar → avisar.
   */
  @Post('onnix/requeue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-encolar filas `failed` del outbox (recuperacion de la DLQ)',
    description:
      'Filtros opcionales y combinables (AND). Sin ningun filtro devuelve 400: ' +
      're-encolar toda la DLQ por accidente no puede ser el default.',
  })
  @ApiResponse({ status: 200, description: 'Cantidad de filas re-encoladas' })
  @ApiResponse({ status: 400, description: 'Sin filtros, o filtros invalidos' })
  @ApiResponse({ status: 401, description: 'No autenticado' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  async requeue(@Body() dto: RequeueFailedDto): Promise<{ requeued: number }> {
    const ids = await this.outbox.resolveFailedIdsForRequeue(dto);
    // `requeueFailed` tal cual (#13 R39): vuelve a `pending` y resetea attempts y
    // lastError. Sin resetear attempts, una fila que llego al cap volveria a caer
    // en `failed` en el primer intento.
    const requeued = await this.outbox.requeueFailed(ids);
    // R3.5: el drenado arranca en segundos (debounce de #50 R4) en vez de esperar
    // al cron. Se llama siempre: es un trigger best-effort e idempotente, y un
    // drenado en vacio son dos queries indexadas — mucho mas barato que dejar al
    // operador mirando la fila 20 minutos sin saber si el requeue "funciono".
    this.outbox.notifyEnqueued();
    return { requeued };
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
