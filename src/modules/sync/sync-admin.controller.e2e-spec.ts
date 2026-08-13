import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mockDeep } from 'jest-mock-extended';
import request from 'supertest';
import { SyncAdminController } from './sync-admin.controller';
import { SyncDispatcherService } from './sync-dispatcher.service';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { OnnixMappingService } from './onnix-mapping.service';
import { OutboxService } from './outbox.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AppConfigService } from '../../config/app.config';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import {
  AppException,
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
  // #51 R3: el endpoint de requeue delega en OutboxService (resolución de filtros
  // + requeueFailed + notifyEnqueued). Mockeado — Prisma nunca se toca acá.
  const outbox = mockDeep<OutboxService>();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SyncAdminController],
      providers: [
        { provide: SyncDispatcherService, useValue: dispatcher },
        { provide: SyncReconciliationService, useValue: reconciliation },
        { provide: OnnixMappingService, useValue: mapping },
        { provide: OutboxService, useValue: outbox },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue(new ToggleGuard('auth'))
      .overrideGuard(RolesGuard)
      .useValue(new ToggleGuard('roles'))
      .compile();

    app = moduleRef.createNestApplication();
    // ValidationPipe con la MISMA configuracion que main.ts (#51 R3.2): sin el, el
    // `RequeueFailedDto` seria decorativo en los tests y un body basura llegaria
    // intacto al service. `forbidNonWhitelisted` es lo que hace que un typo tipo
    // `eventTypes` sea un 400 y no un requeue mas grande de lo que el operador
    // creia pedir. Los otros endpoints no reciben body, asi que es no-op para ellos.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
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
    // #51 FIX A: por defecto NO hay drenado en vuelo (el camino normal del drain).
    dispatcher.isDraining.mockReset();
    dispatcher.isDraining.mockReturnValue(false);
    mapping.seedTicketTypeMappings.mockReset();
    outbox.resolveFailedIdsForRequeue.mockReset();
    outbox.requeueFailed.mockReset();
    outbox.notifyEnqueued.mockReset();
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

  /**
   * #51 FIX A — el endpoint admin era el otro disparador que llamaba
   * `processPending()` sin mirar si ya habia un drenado en vuelo (dos clicks en
   * el boton, o un click mientras corre el cron/el debounce, arrancaban un
   * SEGUNDO drenado en el mismo proceso: locks que vencen mientras el otro drena,
   * escrituras terminales que pisan filas ajenas y conversacion desordenada en OSD).
   *
   * 200 con `skipped` y no 409 a proposito: la peticion no fallo — el trabajo que
   * venia a pedir se esta haciendo AHORA. Un 409 obligaria a cada script de
   * operacion a tratar "clickeaste dos veces" como error y a reintentar, que es lo
   * unico que puede empeorar el solapamiento.
   */
  it('FIX A: con un drenado EN VUELO responde 200 { synced: 0, failed: 0, skipped: true } sin drenar', async () => {
    dispatcher.isDraining.mockReturnValue(true);

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/drain');

    // Primero lo que de verdad importa: NO se arranco un segundo drenado. El body
    // es como se lo cuenta al operador; que no haya solapamiento es el fix.
    expect(dispatcher.processPending).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: 0, failed: 0, skipped: true });
  });

  it('FIX A: en el camino normal el body NO lleva `skipped` (contrato de #13 intacto)', async () => {
    dispatcher.processPending.mockResolvedValueOnce({ synced: 1, failed: 0 });

    const res = await request(app.getHttpServer()).post('/admin/sync/onnix/drain');

    // Los ceros con `skipped` se distinguen de los ceros de "no habia nada que
    // hacer"; el camino normal sigue siendo exactamente { synced, failed }.
    expect(res.body).not.toHaveProperty('skipped');
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

  /**
   * #51 R3 (D4) — `POST /admin/sync/onnix/requeue`, recuperacion de la DLQ.
   *
   * El controller solo ORQUESTA: resolver filtros → `requeueFailed(ids)` →
   * `notifyEnqueued()`. La semantica de los filtros se prueba contra el where real
   * en `outbox.service.spec.ts`; aca se prueba lo que solo se ve por HTTP: que el
   * body llega al service sin manosear, que el 400 del service sale como 400 (y no
   * como 500 del filtro global), que el count que se devuelve es el del UPDATE, y
   * que el endpoint vive detras de los MISMOS guards que drain/reconcile.
   */
  describe('requeue (#51 R3) — recuperacion de la DLQ', () => {
    const REQUEUE_URL = '/admin/sync/onnix/requeue';

    /** El 400 exacto que tira `resolveFailedIdsForRequeue` sin filtros (R3.2). */
    const noFiltersError = () =>
      new AppException(
        'Especifica al menos un filtro (ids, eventType u onlyDryRun) para re-encolar.',
        'SYNC_REQUEUE_NO_FILTERS',
        400,
      );

    it('R3.1: 401 sin sesion, sin resolver ni re-encolar nada', async () => {
      ToggleGuard.authOutcome = '401';

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ onlyDryRun: true });

      expect(res.status).toBe(401);
      expect(outbox.resolveFailedIdsForRequeue).not.toHaveBeenCalled();
      expect(outbox.requeueFailed).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('R3.1: 403 sin rol interno, sin resolver ni re-encolar nada', async () => {
      ToggleGuard.rolesOutcome = '403';

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ eventType: 'COMMENT_ADDED' });

      expect(res.status).toBe(403);
      // Un requeue masivo es una accion de operador: el guard tiene que cortar
      // ANTES de tocar el outbox, no despues.
      expect(outbox.resolveFailedIdsForRequeue).not.toHaveBeenCalled();
      expect(outbox.requeueFailed).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('por ids: 200 -> { requeued } y re-encola EXACTAMENTE los ids resueltos', async () => {
      // El service devuelve solo las que estaban `failed`: de los 3 pedidos, 2.
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['row_a', 'row_b']);
      outbox.requeueFailed.mockResolvedValueOnce(2);

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ ids: ['row_a', 'row_b', 'row_viva'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requeued: 2 });
      // El body llega al service TAL CUAL (el controller no arma queries ni
      // pre-filtra: la frontera de repositorio es OutboxService).
      expect(outbox.resolveFailedIdsForRequeue).toHaveBeenCalledWith({
        ids: ['row_a', 'row_b', 'row_viva'],
      });
      // Y se re-encolan los ids RESUELTOS, no los que mando el operador.
      expect(outbox.requeueFailed).toHaveBeenCalledWith(['row_a', 'row_b']);
    });

    it('por eventType: el filtro viaja al service y se re-encola lo resuelto', async () => {
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['row_c1', 'row_c2', 'row_c3']);
      outbox.requeueFailed.mockResolvedValueOnce(3);

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ eventType: 'COMMENT_ADDED' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requeued: 3 });
      expect(outbox.resolveFailedIdsForRequeue).toHaveBeenCalledWith({
        eventType: 'COMMENT_ADDED',
      });
    });

    it('por onlyDryRun: el caso del rollout (#50 R5.3) llega como booleano, no como "true"', async () => {
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['row_dry']);
      outbox.requeueFailed.mockResolvedValueOnce(1);

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ onlyDryRun: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requeued: 1 });
      // El chequeo del service es `=== true`: si el pipe dejara pasar el string
      // "true", el filtro no se aplicaria y el endpoint devolveria 400 sin filtros.
      expect(outbox.resolveFailedIdsForRequeue).toHaveBeenCalledWith({ onlyDryRun: true });
    });

    it('filtros combinados: los TRES viajan juntos en la misma llamada (AND)', async () => {
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['row_x']);
      outbox.requeueFailed.mockResolvedValueOnce(1);

      const res = await request(app.getHttpServer()).post(REQUEUE_URL).send({
        ids: ['row_x', 'row_y'],
        eventType: 'COMMENT_ADDED',
        onlyDryRun: true,
      });

      expect(res.status).toBe(200);
      expect(outbox.resolveFailedIdsForRequeue).toHaveBeenCalledWith({
        ids: ['row_x', 'row_y'],
        eventType: 'COMMENT_ADDED',
        onlyDryRun: true,
      });
      expect(outbox.requeueFailed).toHaveBeenCalledWith(['row_x']);
    });

    it('R3.2: SIN filtros -> 400 con code SYNC_REQUEUE_NO_FILTERS y NADA re-encolado', async () => {
      outbox.resolveFailedIdsForRequeue.mockRejectedValueOnce(noFiltersError());

      const res = await request(app.getHttpServer()).post(REQUEUE_URL).send({});

      // 400, no 500: la AppException del service tiene que sobrevivir el viaje
      // hasta el GlobalExceptionFilter con su statusCode y su code.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SYNC_REQUEUE_NO_FILTERS');
      // Lo importante del test: el requeue NO ocurre. Si el controller atrapara el
      // error y siguiera, se re-encolaria la DLQ entera — el accidente que R3.2
      // viene a impedir.
      expect(outbox.requeueFailed).not.toHaveBeenCalled();
      expect(outbox.notifyEnqueued).not.toHaveBeenCalled();
    });

    it('R3.2: `onlyDryRun: false` llega al service tal cual (y ahi es 400, no un filtro)', async () => {
      outbox.resolveFailedIdsForRequeue.mockRejectedValueOnce(noFiltersError());

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ onlyDryRun: false });

      expect(res.status).toBe(400);
      // El controller no interpreta el filtro: pasa el DTO. Que `false` no cuente
      // como filtro es regla del repositorio (pinneada en outbox.service.spec.ts),
      // y asi vale tambien para un cron o un script que llame al service directo.
      expect(outbox.resolveFailedIdsForRequeue).toHaveBeenCalledWith({ onlyDryRun: false });
      expect(outbox.requeueFailed).not.toHaveBeenCalled();
    });

    it('R3.5: notifyEnqueued se llama DESPUES de re-encolar (no antes)', async () => {
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['row_a']);
      outbox.requeueFailed.mockResolvedValueOnce(1);

      await request(app.getHttpServer()).post(REQUEUE_URL).send({ ids: ['row_a'] });

      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
      // El orden no es cosmetico: el drain arranca con debounce de segundos, pero
      // si el aviso saliera ANTES del UPDATE, el drenado podria correr con la fila
      // todavia en `failed` y volver en vacio — el operador esperaria al cron.
      expect(outbox.notifyEnqueued.mock.invocationCallOrder[0]).toBeGreaterThan(
        outbox.requeueFailed.mock.invocationCallOrder[0],
      );
    });

    it('R3.5: avisa igual con 0 re-encoladas (trigger best-effort, no condicional)', async () => {
      // Ids que ya no estaban `failed`. Se avisa igual a proposito: un drenado en
      // vacio son dos queries indexadas, mucho mas barato que un `if` que se
      // olvide de avisar justo cuando otra fila si quedo lista.
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce([]);
      outbox.requeueFailed.mockResolvedValueOnce(0);

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ ids: ['row_ya_synced'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requeued: 0 });
      expect(outbox.requeueFailed).toHaveBeenCalledWith([]);
      expect(outbox.notifyEnqueued).toHaveBeenCalledTimes(1);
    });

    it('el count devuelto es el del UPDATE, no el de los ids resueltos', async () => {
      // Carrera real: entre el SELECT de resolucion y el UPDATE alguien toco una
      // fila. `requeueFailed` re-filtra por `failed` y re-encola 2 de 3. Devolver
      // `ids.length` seria mentirle al operador sobre lo que quedo encolado.
      outbox.resolveFailedIdsForRequeue.mockResolvedValueOnce(['r1', 'r2', 'r3']);
      outbox.requeueFailed.mockResolvedValueOnce(2);

      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ eventType: 'TICKET_CREATED' });

      expect(res.body).toEqual({ requeued: 2 });
    });

    it('ValidationPipe: un campo desconocido es 400 y no llega al service', async () => {
      // `eventTypes` (con S) con `forbidNonWhitelisted` es 400. Sin el, el campo se
      // caeria silencioso, el DTO quedaria vacio y el operador recibiria un 400 de
      // "sin filtros" que no explica el typo... o peor, si mandara ademas un filtro
      // valido, re-encolaria mucho mas de lo que creia pedir.
      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ eventTypes: 'COMMENT_ADDED' });

      expect(res.status).toBe(400);
      expect(outbox.resolveFailedIdsForRequeue).not.toHaveBeenCalled();
      expect(outbox.requeueFailed).not.toHaveBeenCalled();
    });

    it('ValidationPipe: un eventType inexistente es 400 y no llega al service', async () => {
      // El @IsIn del DTO es lo que evita que un valor libre entre al where: un
      // eventType que no existe matchearia 0 filas y devolveria un 200 { requeued:
      // 0 } indistinguible de "no habia nada que recuperar".
      const res = await request(app.getHttpServer())
        .post(REQUEUE_URL)
        .send({ eventType: 'COMMENT_DELETED' });

      expect(res.status).toBe(400);
      expect(outbox.resolveFailedIdsForRequeue).not.toHaveBeenCalled();
    });

    it('ValidationPipe: `ids: []` es 400 en la puerta (@ArrayNotEmpty)', async () => {
      // Doble reja con el 400 del service: el DTO lo corta antes de llegar.
      const res = await request(app.getHttpServer()).post(REQUEUE_URL).send({ ids: [] });

      expect(res.status).toBe(400);
      expect(outbox.resolveFailedIdsForRequeue).not.toHaveBeenCalled();
    });
  });
});
