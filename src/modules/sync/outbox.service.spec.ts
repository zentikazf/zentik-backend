import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { OutboxService } from './outbox.service';
import { PrismaService } from '../../database/prisma.service';
import { AppConfigService } from '../../config/app.config';
import { EnqueueInput, OutboxRow } from './types/outbox.types';

// Los getters de AppConfigService son read-only; el mock los hace asignables en
// runtime pero TS sigue viendo el tipo real. Cast puntual documentado para poder
// fijar valores de config en los tests.
type WritableConfig = { -readonly [K in keyof AppConfigService]: AppConfigService[K] };

/**
 * Tests de OutboxService (feature #13).
 *
 * Prisma MOCKEADO con jest-mock-extended (`mockDeep`) — NUNCA toca DATABASE_URL
 * (prod). Verificamos comportamiento de repositorio del outbox, no la DB real.
 *
 * Cubre: T17 (R1/R2 enqueueTx en la tx + rollback), T18 (R11/R12 claim atomico).
 */
describe('OutboxService', () => {
  let service: OutboxService;
  let prisma: DeepMockProxy<PrismaService>;
  let config: DeepMockProxy<AppConfigService> & WritableConfig;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = mockDeep<AppConfigService>() as DeepMockProxy<AppConfigService> & WritableConfig;
    service = new OutboxService(prisma, config);
  });

  describe('enqueueTx — R1: escribe outbox-row pending DENTRO de la tx del caller', () => {
    it('R1: escribe una row con status=pending usando el tx recibido (no abre su propia tx)', async () => {
      // tx mockeado: simula el Prisma.TransactionClient que pasa el caller.
      const tx = mockDeep<Prisma.TransactionClient>();
      const input: EnqueueInput = {
        eventType: 'TICKET_CREATED',
        aggregateId: 'ticket_cuid_1',
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
        payload: { ticketId: 'ticket_s1' },
      });
      const arg = tx.outboxEvent.create.mock.calls[0][0];
      expect(arg.data).toMatchObject({ eventType: 'STATUS_CHANGED', aggregateId: 'ticket_s1' });
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
      expect(arg.data).toMatchObject({ status: 'pending', lockedAt: null });
      expect(arg.data).not.toHaveProperty('attempts');
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

function makeRow(id: string): OutboxRow {
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
    created_at: new Date(),
    synced_at: null,
  };
}
