import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * F2 (#26) — filtro opcional `movement` en getHoursSummary.
 *
 * R10: bucket ACUMULADAS ⇒ type ∈ {PURCHASE, REFUND}; DESCUENTO ⇒ {USAGE, LOAN}.
 * R11: movement ausente ⇒ where SIN filtro de type (byte-idéntico al actual, incl. INTERNAL).
 * R12: movement inválido ⇒ AppException 400 INVALID_MOVEMENT_FILTER sin ejecutar la query.
 * R13: KPI totalAmount invariante ante movement (el aggregate mantiene su propio type USAGE/LOAN).
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientService — filtro de movimiento en getHoursSummary (F2 #26)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let email: DeepMockProxy<EmailInvitationService>;
  let onboarding: DeepMockProxy<OnboardingService>;
  let service: ClientService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    email = mockDeep<EmailInvitationService>();
    onboarding = mockDeep<OnboardingService>();
    service = new ClientService(prisma, audit, email, onboarding);

    // findById → cliente válido.
    prisma.client.findFirst.mockResolvedValue({
      id: CLIENT,
      organizationId: ORG,
      currency: 'PYG',
      contractedHours: 100,
      usedHours: 40,
      loanedHours: 0,
      developmentHourlyRate: null,
      supportHourlyRate: null,
    } as never);

    // $transaction([findMany, count, aggregate]) → tupla vacía y sin monto facturable.
    prisma.$transaction.mockResolvedValue([
      [],
      0,
      { _sum: { priceAmount: null } },
    ] as never);
  });

  it('movement=ACUMULADAS ⇒ findMany y count filtran type ∈ {PURCHASE, REFUND} (R10)', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20, 'ACUMULADAS');

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { in: ['PURCHASE', 'REFUND'] } }),
      }),
    );
    expect(prisma.hoursTransaction.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { in: ['PURCHASE', 'REFUND'] } }),
      }),
    );
  });

  it('movement=DESCUENTO ⇒ findMany y count filtran type ∈ {USAGE, LOAN} (R10)', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20, 'DESCUENTO');

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { in: ['USAGE', 'LOAN'] } }),
      }),
    );
    expect(prisma.hoursTransaction.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { in: ['USAGE', 'LOAN'] } }),
      }),
    );
  });

  it('movement ausente ⇒ where sin filtro de type (byte-idéntico, incl. INTERNAL) (R11)', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20);

    // where exacto = { clientId, deletedAt: null } ⇒ NO tiene la clave `type`.
    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: CLIENT, deletedAt: null } }),
    );
    expect(prisma.hoursTransaction.count).toHaveBeenCalledWith({
      where: { clientId: CLIENT, deletedAt: null },
    });
  });

  it('movement inválido ⇒ 400 INVALID_MOVEMENT_FILTER sin ejecutar la query del ledger (R12)', async () => {
    await expect(
      service.getHoursSummary(ORG, CLIENT, 1, 20, 'XYZ'),
    ).rejects.toMatchObject({ code: 'INVALID_MOVEMENT_FILTER', statusCode: 400 });

    expect(prisma.hoursTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.hoursTransaction.count).not.toHaveBeenCalled();
  });

  it('KPI totalAmount invariante: el aggregate conserva type ∈ {USAGE, LOAN} aun con movement=ACUMULADAS (R13)', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20, 'ACUMULADAS');

    // El spread `{ ...where, type: {in:['USAGE','LOAN']} }` pisa el bucket del filtro.
    expect(prisma.hoursTransaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: ['USAGE', 'LOAN'] },
          priceAmount: { not: null },
        }),
      }),
    );
  });

  it('H9b — el aggregate del KPI excluye las filas ESPEJO (rebilledFromTransactionId: null) para no doble-contar', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20);

    expect(prisma.hoursTransaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rebilledFromTransactionId: null }),
      }),
    );
  });
});
