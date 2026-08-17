import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #53 — cap del `limit` de getHoursSummary: sube de 100 a 500.
 *
 * Regla: la vista de cards por mes del staff agrupa en el CLIENTE, asi que necesita el
 * ledger completo en una sola respuesta. Si el backend trunca a mitad de un mes, el total
 * de esa card miente (suma solo la porcion que entro en la pagina).
 *
 * L1: limit=500 se respeta tal cual ⇒ take: 500.
 * L2: limit=501 se capea a 500 (el techo sigue existiendo, solo se movio).
 * L3: sin `limit` explicito el default de la firma sigue siendo 20 (compatibilidad con
 *     cualquier consumidor viejo que no mande el query param).
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientService — cap del limit en getHoursSummary (#53)', () => {
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

  it('limit=500 se respeta ⇒ take: 500 y skip coherente con la página (L1)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT, 1, 500);

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500, skip: 0 }),
    );
    expect(result.limit).toBe(500);
  });

  it('limit=501 se capea a 500 (L2)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT, 1, 501);

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
    expect(result.limit).toBe(500);
  });

  it('sin limit explícito el default sigue siendo 20 ⇒ take: 20 (L3)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT);

    expect(prisma.hoursTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
    expect(result.limit).toBe(20);
  });
});
