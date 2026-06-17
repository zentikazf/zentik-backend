import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { SyncReconciliationService } from './sync-reconciliation.service';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from './outbox.service';

/**
 * Tests de SyncReconciliationService (feature #13).
 *
 * Prisma MOCKEADO, OutboxService MOCKEADO. NUNCA toca DATABASE_URL.
 *
 * Cubre: T25 (R39 re-encola failed re-evaluable tras agregar mapeo;
 * R40 detecta ticket sin outbox-row).
 */
describe('SyncReconciliationService', () => {
  let service: SyncReconciliationService;
  let prisma: DeepMockProxy<PrismaService>;
  let outbox: DeepMockProxy<OutboxService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    outbox = mockDeep<OutboxService>();
    service = new SyncReconciliationService(prisma, outbox);
  });

  describe('R39 — re-encolar failed re-evaluable', () => {
    it('re-encola la fila failed cuyo cliente HOY ya tiene mapeo (scoped por org)', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { id: 'row_failed_1', aggregateId: 'ticket_1', payload: { clientId: 'client_ahora_mapeado' } },
      ] as never);
      // La org del ticket se resuelve por aggregateId (el payload no la persiste).
      prisma.ticket.findUnique.mockResolvedValueOnce({ organizationId: 'org-test' } as never);
      // El cliente ahora SI tiene fila en onnix_entity_mappings para esa org.
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce({ id: 'map_1' } as never);
      // Sin tickets faltantes.
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);
      outbox.requeueFailed.mockResolvedValueOnce(1);

      const res = await service.reconcileV1();

      // El lookup del mapeo usa la clave compuesta org+entityType+zentikId.
      const arg = prisma.onnixEntityMapping.findUnique.mock.calls[0][0];
      expect(arg.where).toEqual({
        organizationId_entityType_zentikId: {
          organizationId: 'org-test',
          entityType: 'client',
          zentikId: 'client_ahora_mapeado',
        },
      });
      expect(outbox.requeueFailed).toHaveBeenCalledWith(['row_failed_1']);
      expect(res.requeued).toBe(1);
    });

    it('NO re-encola si el cliente sigue sin mapeo en esa org', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { id: 'row_failed_2', aggregateId: 'ticket_2', payload: { clientId: 'client_sin_mapeo' } },
      ] as never);
      prisma.ticket.findUnique.mockResolvedValueOnce({ organizationId: 'org-test' } as never);
      prisma.onnixEntityMapping.findUnique.mockResolvedValueOnce(null); // sigue sin mapeo
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);
      outbox.requeueFailed.mockResolvedValueOnce(0);

      const res = await service.reconcileV1();

      expect(outbox.requeueFailed).toHaveBeenCalledWith([]); // lista vacia
      expect(res.requeued).toBe(0);
    });

    it('ignora filas failed sin clientId en el payload', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([
        { id: 'row_sin_client', payload: {} },
      ] as never);
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);
      outbox.requeueFailed.mockResolvedValueOnce(0);

      await service.reconcileV1();

      expect(prisma.onnixEntityMapping.findUnique).not.toHaveBeenCalled();
      expect(outbox.requeueFailed).toHaveBeenCalledWith([]);
    });
  });

  describe('R40 — detectar tickets sin outbox-row', () => {
    it('reporta el count de tickets recientes sin TICKET_CREATED', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([]); // sin failed
      outbox.requeueFailed.mockResolvedValueOnce(0);
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 2n }]); // 2 tickets sin row

      const res = await service.reconcileV1();

      expect(res.missing).toBe(2);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('missing=0 cuando todos los tickets tienen su outbox-row', async () => {
      prisma.outboxEvent.findMany.mockResolvedValueOnce([]);
      outbox.requeueFailed.mockResolvedValueOnce(0);
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 0n }]);

      const res = await service.reconcileV1();

      expect(res.missing).toBe(0);
    });
  });
});
