import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  OutboxService,
  OUTBOX_ENQUEUED_EVENT,
  SKIPPED_MESSAGE_DELETED_EXTERNAL_ID,
} from './outbox.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { AppException } from '../../common/filters/app-exception';
import {
  EnqueueInput,
  OutboxEventType,
  OutboxRow,
  OutboxStatus,
} from './types/outbox.types';

// Los getters de AppConfigService son read-only; el mock los hace asignables en
// runtime pero TS sigue viendo el tipo real. Cast puntual documentado para poder
// fijar valores de config en los tests.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Marcador EXACTO que escribe el dispatcher al simular (#50 R27/R43) y que el
 * filtro `onlyDryRun` busca por prefijo (#51 R3.3). Va arriba y no al pie con los
 * helpers a proposito: los cuerpos de `describe` corren durante la evaluacion del
 * modulo, asi que un `const` declarado abajo estaria en TDZ.
 */
const DRY_RUN_ERROR = 'DRY_RUN: simulacro, no enviado a Onnix';

/**
 * Tests de OutboxService (feature #13 + #50).
 *
 * Prisma MOCKEADO con jest-mock-extended (`mockDeep`) — NUNCA toca DATABASE_URL
 * (prod). Verificamos comportamiento de repositorio del outbox, no la DB real.
 *
 * Cubre: T17 (R1/R2 enqueueTx en la tx + rollback), T18 (R11/R12 claim atomico)
 * y #50 D8 (enqueueTx: boolean + notifyEnqueued post-commit + COMMENT_ADDED).
 */
describe('OutboxService', () => {
  let service: OutboxService;
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;
  // EventEmitter2 mockeado (#50 D8): notifyEnqueued emite `outbox.enqueued` y el
  // dispatcher lo escucha para agendar el drain. Aca solo verificamos la emision.
  let events: DeepMockProxy<EventEmitter2>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    events = mockDeep<EventEmitter2>();
    // Scoping multi-tenant: feature on + org de los tests habilitada, para que el
    // gate de enqueueTx deje pasar las escrituras de las pruebas existentes.
    config.onnixSyncEnabled = true;
    config.onnixSyncOrgIds = ['org-test'];
    service = new OutboxService(prisma, config, events);
  });

  describe('enqueueTx — R1: escribe outbox-row pending DENTRO de la tx del caller', () => {
    it('R1: escribe una row con status=pending usando el tx recibido (no abre su propia tx)', async () => {
      // tx mockeado: simula el Prisma.TransactionClient que pasa el caller.
      const tx = mockDeep<Prisma.TransactionClient>();
      const input: EnqueueInput = {
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_cuid_1',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_cuid_1', clientId: 'client_1', projectId: 'project_1' },
      };

      await service.enqueueTx(tx, input);

      // Usa el create del tx del caller (R1), NO prisma.outboxEvent.create directo.
      expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
      const arg = tx.outboxEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_cuid_1',
        status: 'pending',
        payloadVersion: 1,
      });
    });

    it('R2: si el tx hace rollback, no queda ninguna row (garantia nativa de Prisma)', async () => {
      // El rollback es responsabilidad del $transaction del caller: si la promesa
      // de la tx rechaza, Prisma revierte TODO lo escrito con ese tx, incluida la
      // outbox-row. Aqui verificamos que enqueueTx NO persiste fuera del tx (no
      // hace ningun write con el prisma global que sobreviviria al rollback).
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.outboxEvent.create.mockRejectedValueOnce(new Error('rollback simulado'));

      await expect(
        service.enqueueTx(tx, {
          eventType: 'TICKET_CREATED',
          aggregateId: 'ticket_x',
          organizationId: 'org-test',
          payload: { ticketId: 'ticket_x', clientId: 'c1' },
        }),
      ).rejects.toThrow('rollback simulado');

      // No hay escritura por fuera del tx que pudiera sobrevivir al rollback.
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
    });

    it('R10: encola STATUS_CHANGED con aggregateId = ticketId dentro del tx', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      await service.enqueueTx(tx, {
        eventType: 'STATUS_CHANGED',
        aggregateId: 'ticket_s1',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_s1' },
      });
      const arg = tx.outboxEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({ eventType: 'STATUS_CHANGED', aggregateId: 'ticket_s1' });
    });
  });

  describe('enqueueTx — GATE de scoping multi-tenant', () => {
    it('org NO habilitada -> no-op (no escribe en el outbox) y devuelve false', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const wrote = await service.enqueueTx(tx, {
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_otra_org',
        organizationId: 'org-no-habilitada',
        payload: { ticketId: 'ticket_otra_org', clientId: 'c1' },
      });
      // El gate corta antes de tocar el tx: no captura tickets de orgs fuera del whitelist.
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
      // #50 D8: false => el caller NO debe llamar notifyEnqueued post-commit.
      expect(wrote).toBe(false);
    });

    it('feature off -> no-op aunque la org este en el whitelist y devuelve false', async () => {
      config.onnixSyncEnabled = false;
      const tx = mockDeep<Prisma.TransactionClient>();
      const wrote = await service.enqueueTx(tx, {
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_flag_off',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_flag_off', clientId: 'c1' },
      });
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
      expect(wrote).toBe(false);
    });
  });

  /**
   * #50 D8 — drain-on-enqueue. El contrato que consumen los 6 call sites (portal
   * create, createByAdmin, updateTicket, closeTicket, chat message, nota interna):
   * `enqueueTx` dice si hubo fila, y SOLO en ese caso el caller llama
   * `notifyEnqueued()` DESPUES del commit (R4.3: si la tx revierte no hay nada
   * que drenar). Por eso el booleano y la emision son dos pasos separados.
   */
  describe('#50 D8 — enqueueTx: booleano + notifyEnqueued post-commit', () => {
    it('D8: devuelve true cuando escribio la fila (flag on + org en la whitelist)', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const wrote = await service.enqueueTx(tx, {
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_ok',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_ok', clientId: 'c1' },
      });
      expect(wrote).toBe(true);
      expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    });

    it('D8/R4.3: enqueueTx NO emite el evento (corre dentro de la tx; el disparo es post-commit)', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      await service.enqueueTx(tx, {
        eventType: 'COMMENT_ADDED',
        aggregateId: 'ticket_no_emit',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_no_emit', messageId: 'msg_1' },
      });
      // Si emitiera aca y la tx revirtiera, el dispatcher drenaria en falso.
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('R4.1: notifyEnqueued emite `outbox.enqueued` por EventEmitter2 y NO toca Prisma', () => {
      service.notifyEnqueued();

      expect(events.emit).toHaveBeenCalledTimes(1);
      // Nombre EXACTO del evento: es el contrato con el @OnEvent del dispatcher.
      expect(events.emit).toHaveBeenCalledWith(OUTBOX_ENQUEUED_EVENT);
      expect(OUTBOX_ENQUEUED_EVENT).toBe('outbox.enqueued');
      // Es un trigger best-effort puro: no lee ni escribe la tabla (la verdad
      // sigue siendo la fila `pending`; el cron es la red de seguridad).
      expect(prisma.outboxEvent.create).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.findFirst).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  /**
   * #50 R2.1/R3.1 — COMMENT_ADDED es UN solo eventType para los DOS origenes
   * (chat y nota interna). El payload es el discriminante que lee el dispatcher,
   * asi que lo importante aca es que la fila lo persista COMPLETO y sin recortes.
   */
  describe('enqueueTx — COMMENT_ADDED (#50 R2.1/R3.1)', () => {
    it('R2.2: chat -> persiste { ticketId, messageId } (el dispatcher RELEE el Message al drenar)', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const wrote = await service.enqueueTx(tx, {
        eventType: 'COMMENT_ADDED',
        aggregateId: 'ticket_chat',
        organizationId: 'org-test',
        payload: { ticketId: 'ticket_chat', messageId: 'msg_cuid_1' },
      });

      expect(wrote).toBe(true);
      const arg = tx.outboxEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        eventType: 'COMMENT_ADDED',
        // aggregateId = ticketId tambien aca: es lo que consulta el gate de orden
        // (getCreatedExternalId por aggregate_id) antes de mandar el comentario.
        aggregateId: 'ticket_chat',
        status: 'pending',
        payloadVersion: 1,
      });
      // Payload EXACTO: sin adminNoteSnapshot => el dispatcher lo clasifica como
      // chat (is_internal: false).
      expect(arg.data.payload).toEqual({ ticketId: 'ticket_chat', messageId: 'msg_cuid_1' });
    });

    it('R3.2: nota interna -> persiste el SNAPSHOT del texto + authorUserId (nunca se relee el ticket)', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      await service.enqueueTx(tx, {
        eventType: 'COMMENT_ADDED',
        aggregateId: 'ticket_nota',
        organizationId: 'org-test',
        payload: {
          ticketId: 'ticket_nota',
          adminNoteSnapshot: 'Version 1 de la nota',
          authorUserId: 'user_admin_1',
        },
      });

      const arg = tx.outboxEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({ eventType: 'COMMENT_ADDED', aggregateId: 'ticket_nota' });
      expect(arg.data.payload).toEqual({
        ticketId: 'ticket_nota',
        adminNoteSnapshot: 'Version 1 de la nota',
        authorUserId: 'user_admin_1',
      });
    });

    it('R3.2: dos guardados rapidos -> DOS filas con snapshots distintos (no se pisa la version intermedia)', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const base = {
        eventType: 'COMMENT_ADDED' as const,
        aggregateId: 'ticket_nota_2',
        organizationId: 'org-test',
      };
      await service.enqueueTx(tx, {
        ...base,
        payload: { ticketId: 'ticket_nota_2', adminNoteSnapshot: 'v1', authorUserId: 'u1' },
      });
      await service.enqueueTx(tx, {
        ...base,
        payload: { ticketId: 'ticket_nota_2', adminNoteSnapshot: 'v2', authorUserId: 'u1' },
      });

      expect(tx.outboxEvent.create).toHaveBeenCalledTimes(2);
      const first = tx.outboxEvent.create.mock.calls[0][0].data.payload as { adminNoteSnapshot: string };
      const second = tx.outboxEvent.create.mock.calls[1][0].data.payload as { adminNoteSnapshot: string };
      // Si el dispatcher releyera el ticket, ambas filas mandarian 'v2' a OSD y se
      // perderia el historial. El snapshot congelado en la fila lo evita.
      expect(first.adminNoteSnapshot).toBe('v1');
      expect(second.adminNoteSnapshot).toBe('v2');
    });

    it('COMMENT_ADDED respeta el gate: org fuera de la whitelist -> false y sin escritura', async () => {
      const tx = mockDeep<Prisma.TransactionClient>();
      const wrote = await service.enqueueTx(tx, {
        eventType: 'COMMENT_ADDED',
        aggregateId: 'ticket_otra_org',
        organizationId: 'org-no-habilitada',
        payload: { ticketId: 'ticket_otra_org', messageId: 'msg_x' },
      });
      expect(wrote).toBe(false);
      expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('claim — R11/R12: reclamo atomico via FOR UPDATE SKIP LOCKED', () => {
    it('R11: marca in_flight atomico y devuelve filas (UPDATE ... RETURNING via $queryRaw)', async () => {
      config.onnixSyncStaleLockMs = 120000;
      const claimed: OutboxRow[] = [
        {
          id: 'row_1',
          event_type: 'TICKET_CREATED',
          aggregate_id: 'ticket_1',
          payload: { ticketId: 'ticket_1', clientId: 'c1' },
          payload_version: 1,
          status: 'in_flight',
          attempts: 0,
          last_error: null,
          external_id: null,
          locked_at: new Date(),
          created_at: new Date(),
          synced_at: null,
        },
      ];
      prisma.$queryRaw.mockResolvedValueOnce(claimed);

      const result = await service.claim(10);

      expect(result).toEqual(claimed);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // La query interpola staleMs y limit como bind params (tagged template),
      // NUNCA con $queryRawUnsafe — verificamos que se usa el helper seguro.
      const sqlParts = prisma.$queryRaw.mock.calls[0][0] as unknown as TemplateStringsArray;
      const sql = Array.isArray(sqlParts) ? sqlParts.join('') : String(sqlParts);
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(sql).toContain("status = 'in_flight'");
      expect(sql).toContain("status = 'pending'");
    });

    /**
     * #50 FIX 1 — ORDEN DE SALIDA del claim.
     *
     * El `ORDER BY created_at` del subquery decide QUE filas entran al lote, pero
     * NO en que orden las emite el `RETURNING` del UPDATE: Postgres las devuelve en
     * el orden del plan. Con #13 daba igual; con COMMENT_ADDED el orden de los POST
     * ES el orden en que OSD muestra la conversacion. Por eso el UPDATE va envuelto
     * en un CTE y el orden se impone DESPUES del RETURNING.
     */
    it('FIX 1: el ORDER BY de salida va DESPUES del RETURNING (CTE), no solo en el subquery', async () => {
      config.onnixSyncStaleLockMs = 120000;
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await service.claim(10);

      const sqlParts = prisma.$queryRaw.mock.calls[0][0] as unknown as TemplateStringsArray;
      const sql = Array.isArray(sqlParts) ? sqlParts.join('') : String(sqlParts);
      // El UPDATE queda envuelto en un CTE...
      expect(sql).toMatch(/WITH\s+claimed\s+AS/i);
      // ...y el orden cronologico se aplica al SELECT de AFUERA. Es lo unico que
      // Postgres garantiza: un ORDER BY dentro del subquery del UPDATE no ordena
      // el RETURNING.
      const afterReturning = sql.slice(sql.toUpperCase().lastIndexOf('RETURNING'));
      expect(afterReturning).toMatch(/ORDER\s+BY\s+created_at/i);
      expect(afterReturning).toMatch(/FROM\s+claimed/i);
      // El ORDER BY del subquery NO se saco: sigue decidiendo que filas entran al
      // lote (las mas viejas primero) junto con FOR UPDATE SKIP LOCKED.
      const beforeReturning = sql.slice(0, sql.toUpperCase().lastIndexOf('RETURNING'));
      expect(beforeReturning).toMatch(/ORDER\s+BY\s+created_at/i);
      expect(beforeReturning).toContain('FOR UPDATE SKIP LOCKED');
      // Y sigue siendo tagged template (bind params), nunca $queryRawUnsafe.
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('FIX 1: devuelve las filas por created_at ASC aunque el RETURNING las emita en orden de plan', async () => {
      config.onnixSyncStaleLockMs = 120000;
      const t1 = makeRow('row_t1', new Date('2026-08-01T10:01:00Z'));
      const t2 = makeRow('row_t2', new Date('2026-08-01T10:02:00Z'));
      const t3 = makeRow('row_t3', new Date('2026-08-01T10:03:00Z'));
      // Postgres emite el RETURNING en orden de heap/plan: desordenado a proposito.
      (prisma.$queryRaw as unknown as jest.Mock).mockImplementation(
        fakePostgresClaim([t3, t1, t2]),
      );

      const rows = await service.claim(10);

      expect(rows.map((r) => r.id)).toEqual(['row_t1', 'row_t2', 'row_t3']);
    });

    /**
     * #51 FIX 7 — el rescate por lock vencido SALTEABA el dedup.
     *
     * El CTE reclama tambien las filas `in_flight` colgadas (locked_at vencido). Ese
     * es el caso MAS ambiguo de todos: el POST salio y el proceso murio antes del
     * markSynced — o sea, cada redeploy de Railway con un drenado en vuelo. Volvia
     * con `attempts` intacto en 0, y el chequeo anti-duplicado del dispatcher
     * (gateado por `attempts > 0`) la dejaba pasar por el camino feliz: re-POST a
     * ciegas de un comentario que probablemente ya estaba en OSD.
     *
     * El fake aplica la semantica REAL de Postgres —el lado derecho del SET se
     * evalua contra la fila VIEJA— asi que solo suma si el SQL trae el CASE.
     */
    it('FIX 7: el rescate de una fila in_flight colgada cuenta como reintento (attempts+1)', async () => {
      config.onnixSyncStaleLockMs = 120000;
      const stale = makeRow('row_stale');
      stale.status = 'in_flight';
      stale.attempts = 0;
      (prisma.$queryRaw as unknown as jest.Mock).mockImplementation(
        fakePostgresClaimAttempts([stale]),
      );

      const [rescued] = await service.claim(10);

      // Sin esto, el dispatcher ve attempts=0 y re-postea sin preguntarle a OSD si
      // el comentario ya llego. Semanticamente el rescate ES un reintento.
      expect(rescued.attempts).toBe(1);
      expect(rescued.status).toBe('in_flight');
    });

    it('FIX 7: una fila `pending` normal NO consume intento (el camino feliz sigue en 0)', async () => {
      config.onnixSyncStaleLockMs = 120000;
      const fresh = makeRow('row_fresh');
      fresh.status = 'pending';
      fresh.attempts = 0;
      (prisma.$queryRaw as unknown as jest.Mock).mockImplementation(
        fakePostgresClaimAttempts([fresh]),
      );

      const [claimed] = await service.claim(10);

      // Si el CASE sumara siempre, cada drenado gastaria presupuesto sin que haya
      // pasado nada malo y ademas dispararia el dedup (una request extra) en el
      // camino feliz, que es justo lo que R2.4 evita.
      expect(claimed.attempts).toBe(0);
    });

    it('FIX 7: el incremento vive DENTRO del UPDATE del CTE y no rompe el orden ni el RETURNING', async () => {
      config.onnixSyncStaleLockMs = 120000;
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await service.claim(10);

      const sqlParts = prisma.$queryRaw.mock.calls[0][0] as unknown as TemplateStringsArray;
      const sql = Array.isArray(sqlParts) ? sqlParts.join('') : String(sqlParts);
      const beforeReturning = sql.slice(0, sql.toUpperCase().lastIndexOf('RETURNING'));
      // El SET condicional va en el UPDATE, no en el SELECT de afuera.
      expect(beforeReturning).toMatch(
        /attempts\s*=\s*attempts\s*\+\s*CASE\s+WHEN\s+status\s*=\s*'in_flight'\s+THEN\s+1\s+ELSE\s+0\s+END/i,
      );
      // Y todo lo que #50 garantizo sigue en pie: CTE + orden despues del RETURNING.
      expect(sql).toMatch(/WITH\s+claimed\s+AS/i);
      const afterReturning = sql.slice(sql.toUpperCase().lastIndexOf('RETURNING'));
      expect(afterReturning).toMatch(/ORDER\s+BY\s+created_at/i);
      expect(afterReturning).toMatch(/FROM\s+claimed/i);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('R12: dos claims concurrentes no devuelven la misma fila (SKIP LOCKED)', async () => {
      config.onnixSyncStaleLockMs = 120000;
      const rowA: OutboxRow = makeRow('row_A');
      const rowB: OutboxRow = makeRow('row_B');
      // Postgres FOR UPDATE SKIP LOCKED: el 1er claim toma row_A, el 2do (concurrente)
      // la salta y toma row_B. Simulamos esa garantia: cada llamada devuelve filas
      // distintas, nunca la misma.
      prisma.$queryRaw.mockResolvedValueOnce([rowA]).mockResolvedValueOnce([rowB]);

      const first = await service.claim(1);
      const second = await service.claim(1);

      expect(first[0].id).toBe('row_A');
      expect(second[0].id).toBe('row_B');
      expect(first[0].id).not.toBe(second[0].id);
    });
  });

  describe('markSynced / markFailed / requeueFailed / release', () => {
    /**
     * Las tres escrituras terminales pasaron de `update` (por id, a secas) a
     * `updateMany` CONDICIONADO a `status: 'in_flight'` (#51 FIX B), asi que el
     * mock tiene que devolver un `{ count }`: el service lo traduce a
     * applied/lost. `count: 1` = la fila seguia siendo nuestra (camino normal).
     */
    beforeEach(() => {
      prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 } as { count: number });
    });

    it('R14: markSynced persiste external_id, status=synced y syncedAt', async () => {
      const outcome = await service.markSynced('row_1', 'TK-2026-000123');
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      // El `status: 'in_flight'` del where NO es decorativo (#51 FIX B): sin el,
      // un drenado que perdio la fila pisa el externalId del que si la posteo y
      // deja un comentario REAL de OSD sin dueño (adoptable => mensaje perdido).
      expect(arg.where).toEqual({ id: 'row_1', status: 'in_flight' });
      expect(arg.data).toMatchObject({ status: 'synced', externalId: 'TK-2026-000123' });
      expect((arg.data as { syncedAt: Date }).syncedAt).toBeInstanceOf(Date);
      expect(outcome).toBe('applied');
    });

    it('markSynced sin externalId no toca external_id (STATUS_CHANGED)', async () => {
      await service.markSynced('row_2');
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.data).toMatchObject({ status: 'synced' });
      expect(arg.data).not.toHaveProperty('externalId');
    });

    it('R30: markFailed terminal=true -> status=failed sin incrementar attempts', async () => {
      await service.markFailed('row_3', 'cliente no mapeado', true);
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_3', status: 'in_flight' });
      expect(arg.data).toMatchObject({ status: 'failed', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
    });

    it('R31: markFailed terminal=false -> vuelve a pending y attempts++', async () => {
      await service.markFailed('row_4', '502 network', false);
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_4', status: 'in_flight' });
      expect(arg.data).toMatchObject({
        status: 'pending',
        attempts: { increment: 1 },
        lockedAt: null,
      });
    });

    /**
     * #51 FIX B — el camino que producia el huerfano. Si el lock vencio y otro
     * drenado rescato la fila (hoy ya `synced`), el `where` de estado hace que
     * el UPDATE no toque NADA: `count: 0` => 'lost'. El drenado viejo tiene que
     * enterarse y NO seguir, en vez de pisar el ancla del que si posteo.
     */
    it.each([
      ['markSynced', () => service.markSynced('row_x', '999')],
      ['markFailed terminal', () => service.markFailed('row_x', 'boom', true)],
      ['markFailed reintentable', () => service.markFailed('row_x', 'boom', false)],
      ['release', () => service.release('row_x')],
    ])(
      '%s devuelve "lost" y loggea ERROR cuando la fila ya no esta in_flight',
      async (_name, call) => {
        prisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 } as {
          count: number;
        });
        const errorSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        await expect(call()).resolves.toBe('lost');

        // ERROR y no WARN: hubo trabajo real (posiblemente un POST a OSD) cuyo
        // resultado no quedo registrado en ningun lado. Tiene que ser alertable.
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('row_x'));
        errorSpy.mockRestore();
      },
    );

    it('R39: requeueFailed re-encola solo filas failed y devuelve el count sumado', async () => {
      // Dos updateMany (#51 FIX 6): uno para COMMENT_ADDED y otro para el resto.
      // El count que ve el operador es la SUMA de los dos, no el de una rama.
      prisma.outboxEvent.updateMany
        .mockResolvedValueOnce({ count: 2 } as { count: number })
        .mockResolvedValueOnce({ count: 1 } as { count: number });

      const n = await service.requeueFailed(['a', 'b', 'c']);

      expect(n).toBe(3);
      // Las DOS ramas conservan `status: 'failed'`: segunda reja contra un drain que
      // pase entre el SELECT de resolucion y este UPDATE.
      for (const call of prisma.outboxEvent.updateMany.mock.calls) {
        expect(call[0].where).toMatchObject({ status: 'failed', id: { in: ['a', 'b', 'c'] } });
        expect(call[0].data).toMatchObject({ status: 'pending', lastError: null });
      }
    });

    it('requeueFailed con lista vacia no toca la DB y devuelve 0', async () => {
      const n = await service.requeueFailed([]);
      expect(n).toBe(0);
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it('release: vuelve a pending sin incrementar attempts (ordering gate)', async () => {
      await service.release('row_5');
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_5', status: 'in_flight' });
      expect(arg.data).toMatchObject({ status: 'pending', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
    });

    it('release: mismo gate de orden para COMMENT_ADDED (#50 R2.4) — no consume intento ni marca error', async () => {
      // Un comentario que llega antes de que el TICKET_CREATED tenga code se
      // libera con este mismo release: NO debe gastar uno de los intentos ni
      // escribir lastError, o una conversacion activa agotaria el cap y caeria a
      // la DLQ sin que haya pasado nada malo.
      await service.release('row_comment');
      expect(prisma.outboxEvent.updateMany).toHaveBeenCalledTimes(1);
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.data).toEqual({ status: 'pending', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
      expect(arg.data).not.toHaveProperty('lastError');
    });
  });

  /**
   * #51 FIX B — el camino EXACTO que producia el huerfano adoptable, probado
   * contra una fila de verdad y no contra un `{ count }` elegido por el test.
   *
   * Escenario: nuestro lock vencio, otro drenado rescato la fila, POSTEO el
   * comentario y la dejo `synced` con SU ancla ('700'). Cuando el drenado viejo
   * llega tarde a escribir su resultado, el `where` de estado tiene que hacer que
   * NO toque nada. Si lo tocara:
   *
   * - `markSynced` pisa el ancla '700' con la suya → el comentario REAL de OSD
   *   queda sin dueño, y como huerfano con `unanchored === 0` el dedup lo considera
   *   ADOPTABLE: una fila posterior con el mismo texto lo adopta, se da por enviada
   *   y NUNCA postea su mensaje. Perdida silenciosa, el peor final posible.
   * - `markFailed(false)` RESUCITA a `pending` una fila ya posteada → el proximo
   *   ciclo la postea otra vez (duplicado).
   * - `markFailed(true)` la entierra en la DLQ → un requeue manual la re-postea.
   * - `release` la devuelve a `pending` → mismo duplicado.
   *
   * El fake aplica el where de verdad (mismo espiritu que `fakeFindMany`), y ademas
   * cablea `update` IGNORANDO el status — que es literalmente lo que hacia la
   * version pre-fix. Con un `mockResolvedValue` fijo estos asserts pasarian aunque
   * alguien borrara el `status: 'in_flight'` del where.
   */
  describe('#51 FIX B — la escritura tardia NO pisa la fila que otro drenado ya cerro', () => {
    type StoredRow = { id: string; status: OutboxStatus; externalId: string | null };
    type WriteArgs = {
      where?: { id?: string; status?: OutboxStatus };
      data?: { status?: OutboxStatus; externalId?: string };
    };
    let row: StoredRow;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      row = { id: 'row_x', status: 'synced', externalId: '700' };
      const write = (args: WriteArgs, ignoreStatus: boolean): number => {
        const where = args?.where ?? {};
        const hit =
          (where.id === undefined || row.id === where.id) &&
          (ignoreStatus || where.status === undefined || row.status === where.status);
        if (!hit) return 0;
        if (args?.data?.status !== undefined) row.status = args.data.status;
        if (args?.data?.externalId !== undefined) row.externalId = args.data.externalId;
        return 1;
      };
      (prisma.outboxEvent.updateMany as unknown as jest.Mock).mockImplementation(
        (args: WriteArgs) => Promise.resolve({ count: write(args, false) }),
      );
      (prisma.outboxEvent.update as unknown as jest.Mock).mockImplementation(
        (args: WriteArgs) => Promise.resolve(write(args, true) ? { ...row } : null),
      );
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    // El ESTADO DE LA FILA se afirma SIEMPRE antes que el valor de retorno: el daño
    // es que la fila ajena quede pisada, y ese tiene que ser el primer assert que se
    // rompa. Con el orden inverso, un fix a medias (devuelve 'lost' pero igual
    // escribe) pasaria el test hasta la linea de abajo.
    it('markSynced tardio NO pisa el ancla del drenado que SI posteo (el huerfano adoptable)', async () => {
      const outcome = await service.markSynced('row_x', '999');

      // El ancla sigue siendo la del que posteo. Pisarla dejaria el comentario 700
      // de OSD sin dueño y adoptable => una fila posterior se daria por enviada sin
      // postear nada. OSD no tiene delete ni update: no hay como arreglarlo despues.
      expect(row).toEqual({ id: 'row_x', status: 'synced', externalId: '700' });
      expect(outcome).toBe('lost');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('row_x'));
    });

    it('markFailed reintentable tardio NO resucita a `pending` una fila ya posteada', async () => {
      const outcome = await service.markFailed('row_x', '503 upstream', false);

      // Volver a `pending` = el proximo ciclo la postea de nuevo: duplicado en el
      // hilo que ve el cliente, por un fallo que ya no era de esta fila.
      expect(row).toEqual({ id: 'row_x', status: 'synced', externalId: '700' });
      expect(outcome).toBe('lost');
    });

    it('markFailed terminal tardio NO entierra en la DLQ una fila ya sincronizada', async () => {
      const outcome = await service.markFailed('row_x', 'boom', true);

      // En `failed` la veria la alerta de DLQ y un requeue manual la re-postearia.
      expect(row).toEqual({ id: 'row_x', status: 'synced', externalId: '700' });
      expect(outcome).toBe('lost');
    });

    it('release tardio NO devuelve a `pending` una fila que otro drenado ya cerro', async () => {
      const outcome = await service.release('row_x');

      expect(row).toEqual({ id: 'row_x', status: 'synced', externalId: '700' });
      expect(outcome).toBe('lost');
    });

    it('CAMINO NORMAL: con la fila todavia `in_flight` las tres escriben igual que siempre', async () => {
      // La contracara obligatoria: si el `where` de estado fuera de mas, el drenado
      // sano tampoco escribiria y TODO quedaria colgado en `in_flight`.
      row = { id: 'row_x', status: 'in_flight', externalId: null };
      await expect(service.markSynced('row_x', '999')).resolves.toBe('applied');
      expect(row).toEqual({ id: 'row_x', status: 'synced', externalId: '999' });

      row = { id: 'row_x', status: 'in_flight', externalId: null };
      await expect(service.markFailed('row_x', '503', false)).resolves.toBe('applied');
      expect(row.status).toBe('pending');

      row = { id: 'row_x', status: 'in_flight', externalId: null };
      await expect(service.release('row_x')).resolves.toBe('applied');
      expect(row.status).toBe('pending');

      // Y sin ruido de ERROR: no hubo ninguna fila perdida.
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('getCreatedExternalId — R23: code de la creacion para gate de ordering', () => {
    it('devuelve el external_id de la TICKET_CREATED ya sincronizada', async () => {
      // Partial: solo selecciona externalId; cast porque el tipo Prisma es completo.
      prisma.outboxEvent.findFirst.mockResolvedValueOnce({
        externalId: 'TK-2026-000999',
      } as never);
      const code = await service.getCreatedExternalId('ticket_1');
      expect(code).toBe('TK-2026-000999');
      const arg = prisma.outboxEvent.findFirst.mock.calls[0][0]!;
      expect(arg.where).toMatchObject({
        aggregateId: 'ticket_1',
        eventType: 'TICKET_CREATED',
        externalId: { not: null },
      });
    });

    it('devuelve null si la creacion aun no tiene code', async () => {
      prisma.outboxEvent.findFirst.mockResolvedValueOnce(null);
      const code = await service.getCreatedExternalId('ticket_2');
      expect(code).toBeNull();
    });
  });

  /**
   * #51 R3.2/R3.3 (D4) — resolucion de filtros del requeue de la DLQ.
   *
   * Estos tests NO stubean `findMany` con una lista fija: corren contra un fake
   * que aplica el `where` recibido igual que lo haria Postgres (`fakeFindMany`,
   * al pie del archivo). Es la unica forma sin DB de probar que el filtro EXISTE
   * de verdad — con un `mockResolvedValue` el test pasaria igual aunque alguien
   * borrara `status: 'failed'` del where, que es justo el defecto mas caro de
   * este endpoint (re-encolar filas vivas y pisar un drenado en curso).
   */
  describe('resolveFailedIdsForRequeue — #51 R3.2/R3.3: recuperacion de la DLQ', () => {
    /**
     * Universo compartido. Mezcla a proposito filas VIVAS (`pending`/`in_flight`)
     * y ya `synced` con las `failed`, porque el invariante que mas importa no es
     * "trae las que pedi" sino "no toca las otras".
     */
    const DATASET: FakeOutboxRow[] = [
      // Ventana de simulacro del rollout (#50 R5.3): quedaron failed con el
      // marcador DRY_RUN. Son el caso de uso concreto de `onlyDryRun`.
      { id: 'f_created_dry', status: 'failed', eventType: 'TICKET_CREATED', lastError: DRY_RUN_ERROR },
      { id: 'f_comment_dry', status: 'failed', eventType: 'COMMENT_ADDED', lastError: DRY_RUN_ERROR },
      // Failed REALES: mismo estado, otra causa. `onlyDryRun` no debe arrastrarlas
      // (re-encolar un poison message es gastar el cap de intentos al pedo).
      { id: 'f_comment_502', status: 'failed', eventType: 'COMMENT_ADDED', lastError: '502 Bad Gateway' },
      { id: 'f_status_nomap', status: 'failed', eventType: 'STATUS_CHANGED', lastError: 'cliente no mapeado' },
      // Fila viva que ya fallo transitoriamente: `markFailed(terminal=false)` la
      // deja `pending` CON lastError. Es la trampa del filtro por eventType/ids.
      { id: 'p_comment_retry', status: 'pending', eventType: 'COMMENT_ADDED', lastError: '502 Bad Gateway' },
      // Reclamada por un drain en curso. Tocarla desde afuera pisa ese drenado.
      { id: 'i_created', status: 'in_flight', eventType: 'TICKET_CREATED', lastError: null },
      { id: 's_comment', status: 'synced', eventType: 'COMMENT_ADDED', lastError: null },
      // Defensiva: hoy el pipeline no produce una fila NO-failed con marcador
      // DRY_RUN (el simulacro marca terminal). Esta aca para que el invariante
      // "solo failed" no dependa de que el pipeline nunca cambie.
      { id: 's_created_dry', status: 'synced', eventType: 'TICKET_CREATED', lastError: DRY_RUN_ERROR },
    ];

    beforeEach(() => {
      (prisma.outboxEvent.findMany as unknown as jest.Mock).mockImplementation(
        fakeFindMany(DATASET),
      );
    });

    it('por ids: devuelve solo los que estan `failed` (una pending/synced NO se re-encola)', async () => {
      const ids = await service.resolveFailedIdsForRequeue({
        // Se piden 4: dos failed, una pending y una synced.
        ids: ['f_comment_502', 'f_status_nomap', 'p_comment_retry', 's_comment'],
      });

      // `status: 'failed'` manda por encima de los ids que pidio el operador: el
      // requeue es recuperacion de la DLQ, no un "volve a pending" de proposito
      // general. Sin ese filtro este expect traeria las 4.
      expect(ids.sort()).toEqual(['f_comment_502', 'f_status_nomap']);
      const arg = prisma.outboxEvent.findMany.mock.calls[0][0]!;
      expect(arg.where).toMatchObject({
        status: 'failed',
        id: { in: ['f_comment_502', 'f_status_nomap', 'p_comment_retry', 's_comment'] },
      });
      // Solo se necesita el id: el resultado alimenta a `requeueFailed(ids)`.
      expect(arg.select).toEqual({ id: true });
    });

    it('por eventType: todas las `failed` de ese tipo, ninguna viva del mismo tipo', async () => {
      const ids = await service.resolveFailedIdsForRequeue({ eventType: 'COMMENT_ADDED' });

      expect(ids.sort()).toEqual(['f_comment_502', 'f_comment_dry']);
      // p_comment_retry (pending, mismo eventType) y s_comment quedan afuera.
      expect(ids).not.toContain('p_comment_retry');
      expect(ids).not.toContain('s_comment');
      const arg = prisma.outboxEvent.findMany.mock.calls[0][0]!;
      expect(arg.where).toMatchObject({ status: 'failed', eventType: 'COMMENT_ADDED' });
      // Sin `ids` no se agrega la clausula: filtrar por `id: { in: undefined }`
      // seria un where distinto y confuso de leer en un log de Prisma.
      expect(arg.where).not.toHaveProperty('id');
    });

    it('por onlyDryRun: solo las del simulacro (lastError empieza con DRY_RUN), no los failed reales', async () => {
      const ids = await service.resolveFailedIdsForRequeue({ onlyDryRun: true });

      // Es EL caso del rollout de #50 R5.3: se valida en prod con dry-run, se
      // apaga el flag y con esto se recupera lo que quedo en la DLQ — sin
      // arrastrar el 502 ni el "cliente no mapeado", que fallaron de verdad.
      expect(ids.sort()).toEqual(['f_comment_dry', 'f_created_dry']);
      const arg = prisma.outboxEvent.findMany.mock.calls[0][0]!;
      // `startsWith`, no igualdad: el marcador es un prefijo ('DRY_RUN: simulacro,
      // no enviado a Onnix') y es el MISMO que ya descarta la alerta de DLQ.
      expect(arg.where).toMatchObject({
        status: 'failed',
        lastError: { startsWith: 'DRY_RUN' },
      });
    });

    it('filtros combinados: se aplican con AND (interseccion), no con OR', async () => {
      const ids = await service.resolveFailedIdsForRequeue({
        ids: ['f_created_dry', 'f_comment_dry', 'f_comment_502'],
        eventType: 'COMMENT_ADDED',
        onlyDryRun: true,
      });

      // Interseccion de los tres: f_created_dry cae por eventType, f_comment_502
      // cae por onlyDryRun. Con OR volverian los tres.
      expect(ids).toEqual(['f_comment_dry']);
      const arg = prisma.outboxEvent.findMany.mock.calls[0][0]!;
      expect(arg.where).toMatchObject({
        status: 'failed',
        id: { in: ['f_created_dry', 'f_comment_dry', 'f_comment_502'] },
        eventType: 'COMMENT_ADDED',
        lastError: { startsWith: 'DRY_RUN' },
      });
    });

    it('SIN ningun filtro: 400 explicito y NI SIQUIERA consulta la DB', async () => {
      await expect(service.resolveFailedIdsForRequeue({})).rejects.toBeInstanceOf(AppException);

      // El codigo y el status son contrato con el frontend/operador: se afirman
      // explicitamente, no alcanza con "tiro algo".
      const err = await service.resolveFailedIdsForRequeue({}).catch((e: AppException) => e);
      expect(err).toBeInstanceOf(AppException);
      expect(err.code).toBe('SYNC_REQUEUE_NO_FILTERS');
      expect(err.statusCode).toBe(400);
      // Corta ANTES del findMany: re-encolar la DLQ entera de un saque no puede
      // ser el default de un endpoint que se invoca a mano contra produccion.
      expect(prisma.outboxEvent.findMany).not.toHaveBeenCalled();
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it('`onlyDryRun: false` NO cuenta como filtro -> sigue siendo 400', async () => {
      // `false` no restringe nada: si contara como filtro, mandarlo seria
      // exactamente el "re-encolar toda la DLQ" que el 400 viene a impedir.
      await expect(
        service.resolveFailedIdsForRequeue({ onlyDryRun: false }),
      ).rejects.toThrow(AppException);
      expect(prisma.outboxEvent.findMany).not.toHaveBeenCalled();
    });

    it('`ids: []` NO cuenta como filtro -> 400 (un array vacio traeria toda la DLQ)', async () => {
      // `{ id: { in: [] } }` en Prisma no matchea nada, pero si el chequeo mirara
      // solo `ids !== undefined` la clausula se armaria igual y devolveria 0 —
      // silencio en vez de error, que es peor para el operador. Y si alguien
      // "arreglara" ese 0 sacando la clausula, se llevaria la DLQ entera.
      await expect(service.resolveFailedIdsForRequeue({ ids: [] })).rejects.toThrow(
        AppException,
      );
      expect(prisma.outboxEvent.findMany).not.toHaveBeenCalled();
    });

    it('sin matches devuelve [] y `requeueFailed([])` no toca la DB', async () => {
      // Camino real del operador que se equivoca de id: 200 con requeued 0, sin
      // un updateMany sin where efectivo dando vueltas.
      const ids = await service.resolveFailedIdsForRequeue({ ids: ['no_existe'] });
      expect(ids).toEqual([]);
      expect(await service.requeueFailed(ids)).toBe(0);
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it('defensa en profundidad: `requeueFailed` VUELVE a filtrar por failed', async () => {
      // Entre el SELECT de resolucion y el UPDATE puede pasar cualquier cosa (un
      // drain, otro operador). El where del updateMany es la segunda reja.
      prisma.outboxEvent.updateMany
        .mockResolvedValueOnce({ count: 1 } as { count: number })
        .mockResolvedValueOnce({ count: 0 } as { count: number });
      const ids = await service.resolveFailedIdsForRequeue({ eventType: 'STATUS_CHANGED' });
      await service.requeueFailed(ids);

      for (const call of prisma.outboxEvent.updateMany.mock.calls) {
        expect(call[0].where).toMatchObject({ status: 'failed', id: { in: ['f_status_nomap'] } });
        // Resetea lastError: sin eso una fila que llego al cap arrastraria el error
        // viejo y el operador no distinguiria el reintento nuevo del fallo anterior.
        expect(call[0].data).toMatchObject({ status: 'pending', lastError: null });
      }
    });
  });

  /**
   * #51 FIX 6 — el requeue rearma la trampa.
   *
   * `attempts` cumple DOS roles: presupuesto de reintentos Y señal "esta fila ya
   * salio a la ruta", que es lo unico que gatea el chequeo anti-duplicado del
   * dispatcher (`row.attempts > 0`). Resetear a 0 borraba el segundo rol junto con
   * el primero: la fila re-encolada —justo la que llego al cap tras N timeouts
   * ambiguos, o sea la que tiene MAS probabilidad de estar ya en OSD— volvia a
   * entrar por el camino feliz y POSTEABA A CIEGAS. Y con el endpoint de requeue de
   * #51 eso es una operacion de un click.
   *
   * El fake aplica el `where` de verdad (igual que `fakeFindMany`): sin eso el test
   * pasaria aunque alguien borrara la particion por eventType.
   */
  describe('requeueFailed — #51 FIX 6: COMMENT_ADDED vuelve con attempts=1, no 0', () => {
    const MIXED: FakeOutboxRow[] = [
      { id: 'f_c1', status: 'failed', eventType: 'COMMENT_ADDED', lastError: 'timeout' },
      { id: 'f_c2', status: 'failed', eventType: 'COMMENT_ADDED', lastError: 'timeout' },
      { id: 'f_created', status: 'failed', eventType: 'TICKET_CREATED', lastError: '502' },
      { id: 'f_status', status: 'failed', eventType: 'STATUS_CHANGED', lastError: '502' },
      // Viva: ninguna rama puede tocarla, aunque el operador mande su id.
      { id: 'p_c3', status: 'pending', eventType: 'COMMENT_ADDED', lastError: null },
    ];

    it('FIX 6: un COMMENT_ADDED re-encolado conserva la señal "ya salio a la ruta" (attempts=1)', async () => {
      const applied = new Map<string, number>();
      (prisma.outboxEvent.updateMany as unknown as jest.Mock).mockImplementation(
        fakeUpdateMany(MIXED, applied),
      );

      const n = await service.requeueFailed(['f_c1', 'f_c2', 'f_created', 'f_status', 'p_c3']);

      // 4 failed re-encoladas; la `pending` no se toca (el where la excluye).
      expect(n).toBe(4);
      expect(applied.get('f_c1')).toBe(1);
      expect(applied.get('f_c2')).toBe(1);
      // Los otros eventTypes siguen en 0: createTicket/setEstado son idempotentes
      // por diseño, no tienen dedup que gatear y no ganan nada perdiendo un intento.
      expect(applied.get('f_created')).toBe(0);
      expect(applied.get('f_status')).toBe(0);
      expect(applied.has('p_c3')).toBe(false);
    });

    it('FIX 6: 1 y no mas — el requeue no puede gastar el presupuesto de reintentos', async () => {
      // Si esto fuera, por ejemplo, `maxAttempts - 1`, un requeue dejaria la fila a
      // un solo fallo de volver a la DLQ y el operador no ganaria nada.
      const applied = new Map<string, number>();
      (prisma.outboxEvent.updateMany as unknown as jest.Mock).mockImplementation(
        fakeUpdateMany(MIXED, applied),
      );

      await service.requeueFailed(['f_c1']);

      expect(applied.get('f_c1')).toBe(1);
    });
  });

  /**
   * #51 FIX 5 — contabilidad de los comentarios ya sincronizados de un ticket.
   *
   * `claimedIds` es lo que hace seguro el dedup por texto. `unanchored` es la señal
   * de que esa contabilidad esta INCOMPLETA: hay comentarios nuestros en OSD que no
   * sabemos cuales son, asi que adoptar uno = dar por enviado un mensaje que nunca
   * salio = perderlo para siempre (OSD no tiene update ni delete de comentario).
   */
  describe('getCommentClaimState — #51 FIX 5', () => {
    it('particiona en UNA sola query: no-null a claimedIds, null contados en unanchored', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { externalId: '101' },
        { externalId: null },
        { externalId: '203' },
        { externalId: null },
      ] as never);

      const state = await service.getCommentClaimState('ticket_1');

      expect(state).toEqual({ claimedIds: ['101', '203'], unanchored: 2 });
      // UNA sola query (no una por clase): la particion es en JS.
      expect(prisma.outboxEvent.findMany).toHaveBeenCalledTimes(1);
    });

    it('el where NO filtra por externalId: si lo hiciera, las filas sin ancla serian invisibles', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([] as never);

      await service.getCommentClaimState('ticket_2');

      const arg = prisma.outboxEvent.findMany.mock.calls[0][0]!;
      expect(arg.where).toEqual({
        aggregateId: 'ticket_2',
        eventType: 'COMMENT_ADDED',
        status: 'synced',
      });
      // Este es EL punto de FIX 5: con `externalId: { not: null }` en el where las
      // filas sin ancla no se podian ni contar, y el dispatcher no tenia como saber
      // que estaba operando a ciegas.
      expect(arg.where).not.toHaveProperty('externalId');
      expect(arg.select).toEqual({ externalId: true });
    });

    it('ticket limpio (todo anclado): unanchored=0 -> el dispatcher puede adoptar', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { externalId: '7' },
        { externalId: '8' },
      ] as never);

      const state = await service.getCommentClaimState('ticket_3');

      expect(state.unanchored).toBe(0);
      expect(state.claimedIds).toEqual(['7', '8']);
    });

    it('ticket sin comentarios sincronizados: estado vacio, no null', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([] as never);
      expect(await service.getCommentClaimState('ticket_4')).toEqual({
        claimedIds: [],
        unanchored: 0,
      });
    });

    it('un externalId vacio cuenta como SIN ancla, no como id reclamado', async () => {
      // Defensivo: un '' en el Set de reclamados no ancla nada y ademas ensuciaria
      // la comparacion. Se cuenta donde corresponde, que ademas apaga la adopcion.
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { externalId: '' },
        { externalId: '55' },
      ] as never);

      const state = await service.getCommentClaimState('ticket_5');

      expect(state.claimedIds).toEqual(['55']);
      expect(state.unanchored).toBe(1);
    });

    /**
     * #51 FIX D — el centinela del mensaje borrado cuenta como ANCLADA.
     *
     * Con `externalId = null` esa fila apagaba el dedup del ticket ENTERO y para
     * siempre (`unanchored > 0` desactiva la adopcion), asi que un unico mensaje
     * borrado hacia que cada timeout posterior de OSD en ese ticket duplicara.
     * El centinela dice la verdad: esta fila no posteo nada, no hay comentario
     * suelto en OSD que ella deba reclamar.
     */
    it('el centinela de mensaje borrado NO cuenta como unanchored (FIX D)', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { externalId: SKIPPED_MESSAGE_DELETED_EXTERNAL_ID },
        { externalId: '77' },
      ] as never);

      const state = await service.getCommentClaimState('ticket_6');

      // unanchored=0 => el dedup del ticket sigue ACTIVO pese al mensaje borrado.
      expect(state.unanchored).toBe(0);
      expect(state.claimedIds).toContain(SKIPPED_MESSAGE_DELETED_EXTERNAL_ID);
    });

    it('el centinela es inerte dentro de claimedIds: no puede ser un id de OSD', () => {
      // Los ids de comentario de OSD son numericos y el dedup compara contra
      // `String(c.id)`, asi que el centinela jamas puede bloquear la adopcion de
      // un comentario real. Es la propiedad que hace segura la decision de arriba.
      expect(Number.isNaN(Number(SKIPPED_MESSAGE_DELETED_EXTERNAL_ID))).toBe(true);
    });
  });

  /**
   * #51 FIX C — el lock se estampa por LOTE, no por fila.
   *
   * `claim` pone `locked_at = now()` una sola vez para las hasta 50 filas del
   * lote, asi que el reloj de ONNIX_SYNC_STALE_LOCK_MS (120s) arranca para todas
   * al mismo tiempo. Con OSD lento (15s de timeout por call, y una fila en
   * reintento paga GET + POST) la ultima fila puede empezar a procesarse ~25 min
   * despues del claim: otro drenado la rescata como lock vencido y la postea
   * mientras el primero todavia la tiene en memoria => comentario duplicado en
   * OSD, que no tiene delete. Refrescando el lock justo antes de tocar la fila,
   * el reloj corre POR FILA.
   */
  describe('renewClaimLock — #51 FIX C', () => {
    it('refresca locked_at por PK y solo si la fila sigue in_flight', async () => {
      prisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 1 } as {
        count: number;
      });

      const outcome = await service.renewClaimLock('row_lock');

      expect(outcome).toBe('applied');
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_lock', status: 'in_flight' });
      expect((arg.data as { lockedAt: Date }).lockedAt).toBeInstanceOf(Date);
    });

    it('devuelve "lost" (WARN, no ERROR) si otro drenado ya se llevo la fila', async () => {
      prisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 0 } as {
        count: number;
      });
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(service.renewClaimLock('row_lock')).resolves.toBe('lost');

      // WARN y no ERROR a proposito: no se pierde nada (la fila la esta
      // procesando el otro drenado), pero el solapamiento tiene que ser visible.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('row_lock'));
      expect(errorSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});

/** Fila minima del universo del fake: solo las columnas que mira el where. */
type FakeOutboxRow = {
  id: string;
  status: OutboxStatus;
  eventType: OutboxEventType;
  lastError: string | null;
};

type FakeFindManyArgs = {
  where?: {
    status?: OutboxStatus;
    id?: { in?: string[] };
    eventType?: OutboxEventType;
    lastError?: { startsWith?: string };
  };
};

/**
 * Emula el `findMany` de Prisma APLICANDO el where recibido, en vez de devolver
 * una lista fija (#51 R3.2). Es lo que convierte estos tests en una prueba del
 * filtro y no del mock: si el where deja de llevar `status: 'failed'`, o si los
 * filtros se combinaran con OR, el fake devuelve filas de mas y el test se pone
 * rojo solo. Mismo espiritu que `fakePostgresClaim` (#50 FIX 1).
 *
 * Semantica fiel de Postgres en el borde que importa: `lastError: { startsWith }`
 * NO matchea NULL (por eso el `?? ''`).
 */
function fakeFindMany(
  dataset: FakeOutboxRow[],
): (args: FakeFindManyArgs) => Promise<{ id: string }[]> {
  return (args: FakeFindManyArgs) => {
    const where = args?.where ?? {};
    const matches = (row: FakeOutboxRow): boolean => {
      if (where.status !== undefined && row.status !== where.status) return false;
      if (where.id?.in !== undefined && !where.id.in.includes(row.id)) return false;
      if (where.eventType !== undefined && row.eventType !== where.eventType) return false;
      if (
        where.lastError?.startsWith !== undefined &&
        !(row.lastError ?? '').startsWith(where.lastError.startsWith)
      ) {
        return false;
      }
      return true;
    };
    return Promise.resolve(dataset.filter(matches).map((row) => ({ id: row.id })));
  };
}

type FakeUpdateManyArgs = {
  where?: {
    status?: OutboxStatus;
    id?: { in?: string[] };
    eventType?: OutboxEventType | { not?: OutboxEventType };
  };
  data?: { attempts?: number };
};

/**
 * Emula el `updateMany` de Prisma APLICANDO el where recibido (#51 FIX 6), en el
 * mismo espiritu que `fakeFindMany`. Registra en `applied` el `attempts` con el que
 * quedo cada fila tocada, que es EL invariante del fix: COMMENT_ADDED vuelve con 1
 * (conserva la señal "ya salio a la ruta" que gatea el dedup) y el resto con 0.
 *
 * Con un `mockResolvedValue` fijo, este test pasaria igual aunque alguien juntara
 * las dos ramas en un solo update con `attempts: 0`.
 */
function fakeUpdateMany(
  dataset: FakeOutboxRow[],
  applied: Map<string, number>,
): (args: FakeUpdateManyArgs) => Promise<{ count: number }> {
  return (args: FakeUpdateManyArgs) => {
    const where = args?.where ?? {};
    const matches = (row: FakeOutboxRow): boolean => {
      if (where.status !== undefined && row.status !== where.status) return false;
      if (where.id?.in !== undefined && !where.id.in.includes(row.id)) return false;
      if (typeof where.eventType === 'string' && row.eventType !== where.eventType) return false;
      if (
        where.eventType !== undefined &&
        typeof where.eventType === 'object' &&
        where.eventType.not !== undefined &&
        row.eventType === where.eventType.not
      ) {
        return false;
      }
      return true;
    };
    const hit = dataset.filter(matches);
    for (const row of hit) applied.set(row.id, args?.data?.attempts ?? -1);
    return Promise.resolve({ count: hit.length });
  };
}

function makeRow(id: string, createdAt: Date = new Date()): OutboxRow {
  return {
    id,
    event_type: 'TICKET_CREATED',
    aggregate_id: `agg_${id}`,
    payload: { ticketId: `agg_${id}`, clientId: 'c1' },
    payload_version: 1,
    status: 'in_flight',
    attempts: 0,
    last_error: null,
    external_id: null,
    locked_at: new Date(),
    created_at: createdAt,
    synced_at: null,
  };
}

/**
 * Emula la semantica REAL de Postgres para el claim (#50 FIX 1), que es lo unico
 * que puede probar el defecto sin una DB:
 *
 * - Un `ORDER BY` DENTRO del subquery del UPDATE elige que filas se bloquean, pero
 *   el `RETURNING` las emite en el orden del plan (aca: `heapOrder`, desordenado).
 * - Solo un `ORDER BY` aplicado DESPUES del RETURNING (el SELECT sobre el CTE)
 *   garantiza el orden de salida.
 *
 * Por eso el fake ordena unicamente cuando encuentra el ORDER BY del lado de
 * afuera: con la version vieja de la query devuelve el desorden, igual que la DB.
 */
function fakePostgresClaim(
  heapOrder: OutboxRow[],
): (strings: TemplateStringsArray) => Promise<OutboxRow[]> {
  return (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    const afterReturning = sql.slice(sql.toUpperCase().lastIndexOf('RETURNING'));
    const ordered = /ORDER\s+BY\s+created_at/i.test(afterReturning);
    return Promise.resolve(
      ordered
        ? [...heapOrder].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        : heapOrder,
    );
  };
}

/**
 * Emula la semantica REAL del `SET` de Postgres para el claim (#51 FIX 7):
 *
 * - El lado derecho de un `SET` se evalua contra la fila VIEJA, asi que el `status`
 *   del CASE es el PRE-update (`pending` o `in_flight`), nunca el `'in_flight'` que
 *   la misma sentencia esta escribiendo. Sin esa fidelidad el test no probaria nada:
 *   con el status nuevo, el CASE matchearia SIEMPRE.
 * - El `RETURNING *` emite la fila NUEVA, que es la que ve el dispatcher.
 *
 * `preRows` son las filas ANTES del claim (con su status y attempts reales). El fake
 * solo incrementa si el SQL trae el CASE, asi que con la version vieja de la query
 * el test se pone rojo solo.
 */
function fakePostgresClaimAttempts(
  preRows: OutboxRow[],
): (strings: TemplateStringsArray) => Promise<OutboxRow[]> {
  return (strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    const bumpsStaleOnly =
      /attempts\s*=\s*attempts\s*\+\s*CASE\s+WHEN\s+status\s*=\s*'in_flight'\s+THEN\s+1\s+ELSE\s+0\s+END/i.test(
        sql,
      );
    return Promise.resolve(
      preRows.map((row) => ({
        ...row,
        attempts:
          bumpsStaleOnly && row.status === 'in_flight' ? row.attempts + 1 : row.attempts,
        status: 'in_flight' as OutboxStatus,
        locked_at: new Date(),
      })),
    );
  };
}
