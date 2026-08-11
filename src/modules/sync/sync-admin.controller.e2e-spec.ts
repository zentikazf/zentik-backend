import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import { SyncAdminController } from './sync-admin.controller';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AppConfigService } from '../../config/app.config';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import {
  ForbiddenException,
  UnauthorizedException,
} from '../../common/filters/app-exception';

/**
 * Tests e2e de SyncAdminController (feature #13).
 *
 * SIN DB: los guards reales (AuthGuard/RolesGuard) dependen de Prisma; aqui se
 * sustituyen por guards mock controlables que simulan los 3 escenarios de
 * seguridad. El GlobalExceptionFilter real mapea AppException a su statusCode
 * (401/403). El dispatcher esta mockeado (no toca HTTP ni DB).
 *
 * Cubre: T24 (R42 401 sin auth, R41 403 sin rol interno, R36/R37 200 con rol
 * interno devuelve { synced, failed }) y el endpoint de seed de tipos (#50
 * R1.3): el controller solo delega en OnnixMappingService, que va mockeado —
 * la lógica del seed (idempotencia, match por slug) se prueba en
 * `onnix-mapping.service.spec.ts`.
 */

// Guard mock cuyo comportamiento se conmuta por test (auth / roles).
class ToggleGuard implements CanActivate {
  static authOutcome: 'pass' | '401' = 'pass';
  static rolesOutcome: 'pass' | '403' = 'pass';
  constructor(private readonly kind: 'auth' | 'roles') {}
  canActivate(_ctx: ExecutionContext): boolean {
    if (this.kind === 'auth') {
      if (ToggleGuard.authOutcome === '401') {
        throw new UnauthorizedException('No autenticado');
      }
      return true;
    }
    if (ToggleGuard.rolesOutcome === '403') {
      throw new ForbiddenException('recurso protegido', 'acceder (requiere rol interno)');
    }
    return true;
  }
}

describe('SyncAdminController (e2e)', () => {
  let app: INestApplication;
  const dispatcher = mockDeep<SyncDispatcherService>();
  const reconciliation = mockDeep<SyncReconciliationService>();
  // #50: el controller ganó la dependencia del seed de tipos; mock, nunca DB.
  const mapping = mockDeep<OnnixMappingService>();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SyncAdminController],
      providers: [
        { provide: SyncDispatcherService, useValue: dispatcher },
        { provide: SyncReconciliationService, useValue: reconciliation },
        { provide: OnnixMappingService, useValue: mapping },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue(new ToggleGuard('auth'))
      .overrideGuard(RolesGuard)
      .useValue(new ToggleGuard('roles'))
      .compile();

    app = moduleRef.createNestApplication();
    // Filtro global real para mapear AppException -> statusCode correcto.
    app.useGlobalFilters(
      new GlobalExceptionFilter({ isProduction: false } as AppConfigService),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    ToggleGuard.authOutcome = 'pass';
    ToggleGuard.rolesOutcome = 'pass';
    dispatcher.processPending.mockReset();
    mapping.seedTicketTypeMappings.mockReset();
  });

  it('R42: 401 sin autenticacion, sin ejecutar el drain', async () => {
    ToggleGuard.authOutcome = '401';

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/drain');

    expect(res.status).toBe(401);
    expect(dispatcher.processPending).not.toHaveBeenCalled();
  });

  it('R41: 403 sin rol interno, sin ejecutar el drain', async () => {
    ToggleGuard.rolesOutcome = '403';

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/drain');

    expect(res.status).toBe(403);
    expect(dispatcher.processPending).not.toHaveBeenCalled();
  });

  it('R36/R37: 200 con rol interno -> devuelve { synced, failed }', async () => {
    dispatcher.processPending.mockResolvedValueOnce({ synced: 3, failed: 1 });

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/drain');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 3, failed: 1 });
    expect(dispatcher.processPending).toHaveBeenCalledTimes(1);
  });

  it('reconcile: 200 con rol interno -> devuelve { requeued, missing }', async () => {
    reconciliation.reconcileV1.mockResolvedValueOnce({ requeued: 2, missing: 0 });

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/reconcile');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 2, missing: 0 });
  });

  // #50 R1.3: el endpoint de seed vive detrás de los MISMOS guards que drain /
  // reconcile (siembra mappings de toda la whitelist de orgs).
  it('seed-ticket-types: 403 sin rol interno, sin sembrar nada', async () => {
    ToggleGuard.rolesOutcome = '403';

    const res = await request(app.getHttpServer()).post(
      '/admin/sync/onnix/seed-ticket-types',
    );

    expect(res.status).toBe(403);
    expect(mapping.seedTicketTypeMappings).not.toHaveBeenCalled();
  });

  it('seed-ticket-types: 200 con rol interno -> devuelve el resultado por org', async () => {
    mapping.seedTicketTypeMappings.mockResolvedValueOnce([
      {
        organizationId: 'org-1',
        created: 10,
        updated: 1,
        alreadyMapped: 1,
        zentikSlugsWithoutPair: ['slug-huerfano'],
        tableSlugsWithoutTicketType: [],
      },
    ]);

    const res = await request(app.getHttpServer()).post(
      '/admin/sync/onnix/seed-ticket-types',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        organizationId: 'org-1',
        created: 10,
        updated: 1,
        alreadyMapped: 1,
        zentikSlugsWithoutPair: ['slug-huerfano'],
        tableSlugsWithoutTicketType: [],
      },
    ]);
    expect(mapping.seedTicketTypeMappings).toHaveBeenCalledTimes(1);
  });
});
