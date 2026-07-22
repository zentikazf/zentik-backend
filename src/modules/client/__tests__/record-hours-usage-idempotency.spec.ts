import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * H2 — Idempotencia de escritura del ledger.
 *
 * recordHoursUsage graba (timeEntryId, entryVersion) en cada cobro. El índice único PARCIAL de
 * la DB (hours_transactions_time_entry_id_entry_version_key WHERE time_entry_id IS NOT NULL) impide
 * que el MISMO time_entry.confirmed cree dos cobros. Cuando el insert choca, Prisma lanza P2002 y
 * recordHoursUsage hace rollback de la $transaction (no cobra, no incrementa) sin propagar el error.
 *
 * NOTA: el unique real solo se ejerce contra Postgres; acá se MOCKEA el P2002 para probar la reacción
 * del servicio. El bump de entry_version que permite el re-cobro legítimo (revert→re-aprobar) vive en
 * time-tracking.service.revertConfirmation y se cubre por separado.
 */
describe('ClientService.recordHoursUsage — H2 idempotencia (candado del ledger)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let service: ClientService;
  let tx: DeepMockProxy<Prisma.TransactionClient>;

  const baseTask = (billable = true) => ({
    id: 'task-1',
    title: 'Ticket soporte',
    type: 'SUPPORT' as const,
    billable,
    hourlyRate: null,
    project: { id: 'p1', name: 'Proyecto', clientId: 'client-1', organizationId: 'org-1' },
  });

  const baseClient = {
    id: 'client-1',
    currency: 'PYG',
    contractedHours: 100,
    usedHours: 0,
    loanedHours: 0,
    supportHourlyRate: 3000,
    developmentHourlyRate: 5000,
  };

  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`time_entry_id`,`entry_version`)',
      { code: 'P2002', clientVersion: '5.22.0' },
    );

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    tx = mockDeep<Prisma.TransactionClient>();
    service = new ClientService(
      prisma,
      audit,
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
    );
    prisma.client.findUnique.mockResolvedValue(baseClient as never);
    prisma.$transaction.mockImplementation((cb: unknown) =>
      (cb as (t: Prisma.TransactionClient) => Promise<unknown>)(tx),
    );
  });

  it('graba timeEntryId + entryVersion en el cobro USAGE', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask(true) as never);

    await service.recordHoursUsage('task-1', 60, { timeEntryId: 'te-1', entryVersion: 3 });

    expect(tx.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'USAGE', timeEntryId: 'te-1', entryVersion: 3 }),
      }),
    );
  });

  it('idempotente: el segundo confirm con la misma clave (P2002) NO re-cobra ni lanza', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask(true) as never);
    tx.hoursTransaction.create.mockRejectedValue(p2002()); // el índice parcial rebota el insert

    // No propaga el error: recordHoursUsage lo captura y retorna.
    await expect(
      service.recordHoursUsage('task-1', 60, { timeEntryId: 'te-1', entryVersion: 1 }),
    ).resolves.toBeUndefined();

    // Rollback: no incrementa el cupo ni audita consumo (el create falló antes del update).
    expect(tx.client.update).not.toHaveBeenCalled();
    expect(audit.create).not.toHaveBeenCalled();
  });

  it('un error que NO es P2002 sí se propaga (no se traga)', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask(true) as never);
    tx.hoursTransaction.create.mockRejectedValue(new Error('DB caída'));

    await expect(
      service.recordHoursUsage('task-1', 60, { timeEntryId: 'te-1', entryVersion: 1 }),
    ).rejects.toThrow('DB caída');
  });

  it('sin opts (caller legado): graba timeEntryId/entryVersion en null y no rompe (queda fuera del índice parcial)', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask(true) as never);

    await service.recordHoursUsage('task-1', 60);

    expect(tx.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timeEntryId: null, entryVersion: null }),
      }),
    );
  });

  it('rama INTERNAL (SUPPORT no facturable) también es idempotente ante P2002', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask(false) as never);
    prisma.hoursTransaction.create.mockRejectedValue(p2002()); // create suelto, fuera de $transaction

    await expect(
      service.recordHoursUsage('task-1', 60, { timeEntryId: 'te-1', entryVersion: 1 }),
    ).resolves.toBeUndefined();

    expect(audit.create).not.toHaveBeenCalled();
  });
});
