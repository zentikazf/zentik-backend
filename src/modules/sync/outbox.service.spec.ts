import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { OutboxService, OUTBOX_ENQUEUED_EVENT } from './outbox.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { EnqueueInput, OutboxRow } from './types/outbox.types';

// Los getters de AppConfigService son read-only; el mock los hace asignables en
// runtime pero TS sigue viendo el tipo real. Cast puntual documentado para poder
// fijar valores de config en los tests.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

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
    it('R14: markSynced persiste external_id, status=synced y syncedAt', async () => {
      await service.markSynced('row_1', 'TK-2026-000123');
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_1' });
      expect(arg.data).toMatchObject({ status: 'synced', externalId: 'TK-2026-000123' });
      expect(arg.data.syncedAt).toBeInstanceOf(Date);
    });

    it('markSynced sin externalId no toca external_id (STATUS_CHANGED)', async () => {
      await service.markSynced('row_2');
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.data).toMatchObject({ status: 'synced' });
      expect(arg.data).not.toHaveProperty('externalId');
    });

    it('R30: markFailed terminal=true -> status=failed sin incrementar attempts', async () => {
      await service.markFailed('row_3', 'cliente no mapeado', true);
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.data).toMatchObject({ status: 'failed', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
    });

    it('R31: markFailed terminal=false -> vuelve a pending y attempts++', async () => {
      await service.markFailed('row_4', '502 network', false);
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.data).toMatchObject({
        status: 'pending',
        attempts: { increment: 1 },
        lockedAt: null,
      });
    });

    it('R39: requeueFailed re-encola solo filas failed y devuelve el count', async () => {
      prisma.outboxEvent.updateMany.mockResolvedValueOnce({ count: 2 } as { count: number });
      const n = await service.requeueFailed(['a', 'b']);
      expect(n).toBe(2);
      const arg = prisma.outboxEvent.updateMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ status: 'failed' });
      expect(arg.data).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('requeueFailed con lista vacia no toca la DB y devuelve 0', async () => {
      const n = await service.requeueFailed([]);
      expect(n).toBe(0);
      expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    });

    it('release: vuelve a pending sin incrementar attempts (ordering gate)', async () => {
      await service.release('row_5');
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row_5' });
      expect(arg.data).toMatchObject({ status: 'pending', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
    });

    it('release: mismo gate de orden para COMMENT_ADDED (#50 R2.4) — no consume intento ni marca error', async () => {
      // Un comentario que llega antes de que el TICKET_CREATED tenga code se
      // libera con este mismo release: NO debe gastar uno de los intentos ni
      // escribir lastError, o una conversacion activa agotaria el cap y caeria a
      // la DLQ sin que haya pasado nada malo.
      await service.release('row_comment');
      expect(prisma.outboxEvent.update).toHaveBeenCalledTimes(1);
      const arg = prisma.outboxEvent.update.mock.calls[0][0];
      expect(arg.data).toEqual({ status: 'pending', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
      expect(arg.data).not.toHaveProperty('lastError');
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
});

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
