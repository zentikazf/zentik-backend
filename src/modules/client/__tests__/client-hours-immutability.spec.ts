import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * R9 (#25) — inmutabilidad de movimientos ya facturados.
 *
 * Editar/eliminar un HoursTransaction con `billedCycleId != null` DEBE responder
 * 409 TRANSACTION_BILLED y NO tocar la fila ni los contadores (no abre $transaction).
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientService — inmutabilidad de horas facturadas (R9)', () => {
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
      contractedHours: 0,
      usedHours: 0,
      loanedHours: 0,
    } as never);
    // Fila ya facturada (billedCycleId no-null).
    prisma.hoursTransaction.findFirst.mockResolvedValue({
      id: 'h1',
      clientId: CLIENT,
      type: 'USAGE',
      hours: 1,
      priceAmount: null,
      priceRate: null,
      priceCurrency: null,
      billedCycleId: 'cyc1',
    } as never);
  });

  it('editar una fila facturada → 409 TRANSACTION_BILLED sin abrir tx (R9 AC1)', async () => {
    await expect(
      service.editHoursTransaction(ORG, CLIENT, 'h1', { hours: 2 }, 'user-1'),
    ).rejects.toMatchObject({ code: 'TRANSACTION_BILLED', statusCode: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('eliminar una fila facturada → 409 TRANSACTION_BILLED sin reversa de contadores (R9 AC2)', async () => {
    await expect(
      service.deleteHoursTransaction(ORG, CLIENT, 'h1', 'user-1', 'motivo'),
    ).rejects.toMatchObject({ code: 'TRANSACTION_BILLED', statusCode: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
