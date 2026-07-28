import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ClientService } from '../client.service';
import { HoursListener } from '../hours.listener';

/**
 * H7 — onTimeEntryReverted reembolsa el CUPO del cobro exacto de una carga MANUAL.
 * Con (timeEntryId, entryVersion) matchea la USAGE/LOAN precisa (no "la más reciente",
 * que sub-reembolsaría con N cargas). Sin version (carrier legacy pre-H7) cae al
 * comportamiento anterior. El reverso del MONTO/plata (REFUND signado, nota de crédito)
 * queda para H9 — acá solo se valida el cupo.
 */
describe('H7 — HoursListener.onTimeEntryReverted (refund keyed)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let clientService: DeepMockProxy<ClientService>;
  let listener: HoursListener;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    clientService = mockDeep<ClientService>();
    listener = new HoursListener(clientService, prisma);
    prisma.$transaction.mockImplementation((cb: any) => cb(prisma) as never);
  });

  it('con entryVersion → busca el cobro EXACTO (timeEntryId+entryVersion) y decrementa usedHours', async () => {
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'usage-1',
      clientId: 'c1',
      type: 'USAGE',
      hours: 3,
    } as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 'task-1', duration: 10800, entryVersion: 1 });

    expect(prisma.hoursTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ taskId: 'task-1', timeEntryId: 'm1', entryVersion: 1 }),
      }),
    );
    expect(prisma.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'REFUND', hours: 3 }) }),
    );
    expect(prisma.client.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usedHours: { decrement: 3 } } }),
    );
  });

  it('LOAN → decrementa loanedHours en vez de usedHours', async () => {
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'loan-1',
      clientId: 'c1',
      type: 'LOAN',
      hours: 2,
    } as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 'task-1', duration: 7200, entryVersion: 1 });

    expect(prisma.client.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { loanedHours: { decrement: 2 } } }),
    );
  });

  it('sin entryVersion (carrier legacy) → NO keyea por timeEntryId (comportamiento anterior)', async () => {
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'usage-x',
      clientId: 'c1',
      type: 'USAGE',
      hours: 5,
    } as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'carrier-1', taskId: 'task-1', duration: 18000 });

    const whereArg = (prisma.hoursTransaction.findFirst.mock.calls[0][0] as any).where;
    expect(whereArg.timeEntryId).toBeUndefined();
    expect(whereArg.entryVersion).toBeUndefined();
  });

  it('sin cobro encontrado → no crea REFUND ni decrementa cupo', async () => {
    prisma.hoursTransaction.findFirst.mockResolvedValue(null as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 'task-1', duration: 10800, entryVersion: 1 });

    expect(prisma.hoursTransaction.create).not.toHaveBeenCalled();
    expect(prisma.client.update).not.toHaveBeenCalled();
  });

  it('H8a — REFUND copia el workedOn del cobro ORIGINAL (no la fecha del revert)', async () => {
    const worked = new Date('2026-06-30'); // trabajado en junio
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'usage-1',
      clientId: 'c1',
      type: 'USAGE',
      hours: 3,
      workedOn: worked,
      createdAt: new Date('2026-07-02'), // cobrado/revertido en julio
    } as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 'task-1', duration: 10800, entryVersion: 1 });

    expect(prisma.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'REFUND', workedOn: worked }),
      }),
    );
  });

  it('H8a — REFUND cae a createdAt cuando el cobro original no tenía workedOn', async () => {
    const created = new Date('2026-07-02');
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'usage-2',
      clientId: 'c1',
      type: 'USAGE',
      hours: 3,
      workedOn: null,
      createdAt: created,
    } as never);

    await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 'task-1', duration: 10800, entryVersion: 1 });

    expect(prisma.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'REFUND', workedOn: created }),
      }),
    );
  });

  describe('H9a — neteo de plata en el revert', () => {
    it('H9a — el findFirst solo considera cargos VIVOS (deletedAt null)', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue(null as never);
      await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 't1', duration: 3600, entryVersion: 1 });
      const whereArg = (prisma.hoursTransaction.findFirst.mock.calls[0][0] as any).where;
      expect(whereArg.deletedAt).toBeNull();
    });

    it('H9a — el REFUND linkea el cargo exacto (reversesTransactionId) y NO lleva priceAmount', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue({
        id: 'usage-1', clientId: 'c1', type: 'USAGE', hours: 3,
        priceAmount: { toString: () => '900000' },
      } as never);
      await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 't1', duration: 10800, entryVersion: 1 });
      const data = (prisma.hoursTransaction.create.mock.calls[0][0] as any).data;
      expect(data.reversesTransactionId).toBe('usage-1');
      expect(data.priceAmount).toBeUndefined(); // el neteo es por tombstone, no por monto negativo
    });

    it('H9a — tombstonea el cargo revertido (deletedAt + motivo + deletedById del evento)', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue({
        id: 'usage-1', clientId: 'c1', type: 'USAGE', hours: 3,
      } as never);
      await listener.onTimeEntryReverted({
        timeEntryId: 'm1', taskId: 't1', duration: 10800, entryVersion: 1, userId: 'user-9',
      });
      expect(prisma.hoursTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usage-1' },
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            deletedById: 'user-9',
            deleteReason: expect.stringContaining('H9a'),
          }),
        }),
      );
      // el decremento de cupo sigue ocurriendo (net-cero intacto)
      expect(prisma.client.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { usedHours: { decrement: 3 } } }),
      );
    });

    it('H9a — LOAN también se tombstonea (y decrementa loanedHours)', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue({
        id: 'loan-1', clientId: 'c1', type: 'LOAN', hours: 2,
      } as never);
      await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 't1', duration: 7200, entryVersion: 1 });
      expect(prisma.hoursTransaction.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'loan-1' } }),
      );
      expect(prisma.client.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { loanedHours: { decrement: 2 } } }),
      );
    });

    it('H9a — P2002 de reverses_transaction_id → skip idempotente sin propagar error', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue({
        id: 'usage-1', clientId: 'c1', type: 'USAGE', hours: 3,
      } as never);
      // meta.target con el índice real: el guard solo trata ESTE unique como "ya revertido".
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002', clientVersion: 'test',
        meta: { target: 'hours_transactions_reverses_transaction_id_key' },
      } as any);
      prisma.$transaction.mockRejectedValueOnce(p2002 as never);
      const logSpy = jest.spyOn((listener as any).logger, 'log');
      const errorSpy = jest.spyOn((listener as any).logger, 'error');
      await expect(
        listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 't1', duration: 10800, entryVersion: 1 }),
      ).resolves.toBeUndefined();
      // tomó la rama idempotente (log), NO el catch genérico (error)
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skip idempotente'));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('H9a — P2002 de OTRO índice NO se traga como idempotente (cae al catch de error)', async () => {
      prisma.hoursTransaction.findFirst.mockResolvedValue({
        id: 'usage-1', clientId: 'c1', type: 'USAGE', hours: 3,
      } as never);
      const p2002Ajeno = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002', clientVersion: 'test',
        meta: { target: ['time_entry_id', 'entry_version'] },
      } as any);
      prisma.$transaction.mockRejectedValueOnce(p2002Ajeno as never);
      const errorSpy = jest.spyOn((listener as any).logger, 'error');
      await listener.onTimeEntryReverted({ timeEntryId: 'm1', taskId: 't1', duration: 10800, entryVersion: 1 });
      // se re-lanzó dentro y lo capturó el catch exterior como error real (no skip silencioso)
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
