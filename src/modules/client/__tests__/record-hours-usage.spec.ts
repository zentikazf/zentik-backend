import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * H1 OBJ-1 — el candado de emergencia del motor de horas.
 *
 * recordHoursUsage debe:
 *   - PROJECT: retornar sin crear NINGUNA HoursTransaction (ni USAGE/LOAN ni INTERNAL),
 *     sin abrir $transaction, sin tocar usedHours/loanedHours ni auditar consumo.
 *   - SUPPORT: preservar el comportamiento actual (crea USAGE + incrementa usedHours).
 *
 * Prisma MOCKEADO (jest-mock-extended) — nunca toca la DB (design.md OBJ-3, R19).
 */
describe('ClientService.recordHoursUsage — H1 candado PROJECT (OBJ-1)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let service: ClientService;
  let tx: DeepMockProxy<Prisma.TransactionClient>;

  const baseTask = (type: 'SUPPORT' | 'PROJECT', billable = true) => ({
    id: 'task-1',
    title: 'Tarea X',
    type,
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

  it('PROJECT facturable NO consume: sin $transaction, sin update de cupo, sin HoursTransaction, sin audit', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask('PROJECT', true) as never);

    await service.recordHoursUsage('task-1', 60);

    expect(prisma.$transaction).not.toHaveBeenCalled();            // client.service.ts:907
    expect(prisma.client.update).not.toHaveBeenCalled();           // no incrementa usedHours/loanedHours
    expect(tx.client.update).not.toHaveBeenCalled();
    expect(prisma.hoursTransaction.create).not.toHaveBeenCalled();  // ni USAGE/LOAN ni INTERNAL
    expect(tx.hoursTransaction.create).not.toHaveBeenCalled();
    expect(audit.create).not.toHaveBeenCalled();                    // no audita client.hours.*
  });

  it('PROJECT NO facturable tampoco deja rastro: no crea HoursTransaction INTERNAL (guard antes del check billable)', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask('PROJECT', false) as never);

    await service.recordHoursUsage('task-1', 60);

    expect(prisma.hoursTransaction.create).not.toHaveBeenCalled();  // ni siquiera INTERNAL (:866)
    expect(audit.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('SUPPORT SÍ consume: abre $transaction, crea USAGE e incrementa usedHours', async () => {
    prisma.task.findUnique.mockResolvedValue(baseTask('SUPPORT', true) as never);

    await service.recordHoursUsage('task-1', 60); // 60 min = 1 h

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.hoursTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'USAGE' }),   // client.service.ts:911 (available>0)
      }),
    );
    expect(tx.client.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usedHours: { increment: 1 } } }), // :927-930
    );
  });
});
