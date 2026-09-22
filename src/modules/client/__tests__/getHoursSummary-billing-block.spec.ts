import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';
import { ClientBillingService } from '../../client-billing/client-billing.service';
import { mockClientBilling } from './client-billing-rollup.mock';

/**
 * #72 A — El bloque `billing` colgado de `getHoursSummary` (A2.2) y el `billingState` por fila
 * (A3.1). Prisma MOCKEADO.
 *
 * El bug que cierra A3.1: el ledger decidía el estado de facturación de cada fila con
 * `tx.billedCycleId ? … : …`, que es EXACTAMENTE el criterio que #62 declaró mentiroso — tener
 * ciclo no significa estar facturado, porque un borrador tiene ciclo y no le cobró a nadie. Con
 * las cards arriba y ese criterio abajo quedaban dos fuentes de estado contradiciéndose a 200
 * píxeles de distancia.
 */
describe('ClientService.getHoursSummary — el bloque billing y el badge por fila (#72 A)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let billing: DeepMockProxy<ClientBillingService>;
  let service: ClientService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  const fila = (id: string, billedCycleId: string | null) => ({
    id,
    type: 'USAGE',
    hours: 1,
    note: null,
    createdAt: new Date('2026-09-10T12:00:00Z'),
    workedOn: new Date('2026-09-10T00:00:00Z'),
    priceAmount: '100000',
    billedCycleId,
    rebilledFromTransactionId: null,
    task: null,
  });

  const rollup = {
    billing: {
      pending: { amount: '400000', taxMode: 'INCLUDED' },
      invoiced: {
        amount: '1000000',
        invoices: [
          {
            id: 'c-draft',
            invoiceNumber: 'FAC-2026-00042',
            kind: 'MONTH',
            status: 'DRAFT',
            periodStart: new Date('2026-08-01T03:00:00Z'),
            periodEnd: new Date('2026-09-01T02:59:59.999Z'),
            cutoffDate: null,
            currency: 'PYG',
            date: new Date('2026-09-01T12:00:00Z'),
            hours: 10,
            amount: '1000000',
            creditedAmount: '0',
            creditedTotal: '0',
            taxMode: null,
          },
        ],
      },
      paid: { amount: '0', invoices: [] },
    },
    stateByCycleId: { 'c-draft': 'PENDING' as const, 'c-sent': 'INVOICED' as const, 'c-paid': 'PAID' as const },
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    billing = mockClientBilling(rollup);
    service = new ClientService(
      prisma,
      mockDeep<AuditService>(),
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
      billing,
    );

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

    prisma.$transaction.mockResolvedValue([
      [fila('tx-sin-ciclo', null), fila('tx-draft', 'c-draft'), fila('tx-sent', 'c-sent'), fila('tx-paid', 'c-paid')],
      4,
      { _sum: { priceAmount: null } },
    ] as never);
  });

  it('A2.2 — el bloque `billing` se cuelga del return y la pantalla sigue pidiendo UN endpoint', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);

    expect(billing.getHoursBillingRollup).toHaveBeenCalledWith(ORG, CLIENT);
    expect(billing.getHoursBillingRollup).toHaveBeenCalledTimes(1);
    expect(res.billing).toEqual(rollup.billing);
  });

  it('A2.2 — el rollup NO hereda el filtro `movement` de las píldoras', async () => {
    await service.getHoursSummary(ORG, CLIENT, 1, 20, 'ACUMULADAS');

    // El `totalAmount` de hoy sí lo hereda, y por eso cambia al apretar una píldora. Las cards
    // tienen su propio where: el rollup se llama con cliente y organización, nada más.
    expect(billing.getHoursBillingRollup).toHaveBeenCalledWith(ORG, CLIENT);
  });

  it('A3.1 — el badge de cada fila sale del ESTADO DEL CICLO, no de `if (billedCycleId)`', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);
    const estadoDe = (id: string) =>
      (res.transactions.find((t: { id: string }) => t.id === id) as { billingState: string }).billingState;

    expect(estadoDe('tx-sent')).toBe('INVOICED');
    expect(estadoDe('tx-paid')).toBe('PAID');
  });

  it('🔴 A3.2 — una fila estampada en un BORRADOR sigue siendo "PENDING"', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);
    const draft = res.transactions.find((t: { id: string }) => t.id === 'tx-draft') as {
      billedCycleId: string | null;
      billingState: string;
    };

    // Tiene ciclo Y sigue pendiente: es justo el par que el criterio viejo no podía expresar, y
    // el que le permite al front etiquetar la fila como "Borrador" sin inventar un cuarto valor
    // en una unión que el front tipa cerrada.
    expect(draft.billedCycleId).toBe('c-draft');
    expect(draft.billingState).toBe('PENDING');
  });

  it('una fila sin ciclo, o con un ciclo que el rollup no conoce, es "PENDING"', async () => {
    prisma.$transaction.mockResolvedValue([
      [fila('tx-sin-ciclo', null), fila('tx-huerfana', 'c-que-no-existe')],
      2,
      { _sum: { priceAmount: null } },
    ] as never);

    const res = await service.getHoursSummary(ORG, CLIENT);

    // Pendiente antes que cobrado, nunca al revés.
    for (const t of res.transactions as Array<{ billingState: string }>) {
      expect(t.billingState).toBe('PENDING');
    }
  });

  it('el `billingState` sólo toma los tres valores que el front tipa', async () => {
    const res = await service.getHoursSummary(ORG, CLIENT);

    for (const t of res.transactions as Array<{ billingState: string }>) {
      expect(['PENDING', 'INVOICED', 'PAID']).toContain(t.billingState);
    }
  });
});
