import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  ClientService,
  HOURS_SUMMARY_MAX_LIMIT,
  HOURS_SUMMARY_MAX_PAGE,
} from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #57 fix A — techo de `page` en getHoursSummary.
 *
 * El bug: `safeLimit` tenia techo (`Math.min(..., HOURS_SUMMARY_MAX_LIMIT)`) pero `safePage` era
 * solo `Math.max(1, page)`, sin techo superior. `skip = (safePage - 1) * safeLimit` con un page
 * gigante desborda el entero de 64 bits de Postgres y Prisma corta con
 * "Unable to fit value 2e+22 into a 64-bit signed integer for field `skip`" ⇒ HTTP 500.
 *
 * Lo importante: NO era un problema de parseo del query param. `?page=99999999999999999999`
 * (digitos planos) reventaba igual ANTES de que el controller saneara nada — por eso el techo va
 * en el SERVICE, donde cubre a cualquier llamador, y por eso estos tests llaman al service directo
 * en vez de pasar por el controller.
 *
 * Prisma MOCKEADO — nunca toca la DB. Lo que se verifica es el `skip` que cruza la frontera:
 * si el numero que llega a Prisma es sano, no hay 500 posible.
 */
describe('ClientService — techo de page en getHoursSummary (#57)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let email: DeepMockProxy<EmailInvitationService>;
  let onboarding: DeepMockProxy<OnboardingService>;
  let service: ClientService;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** Techo de un entero con signo de 64 bits: el limite que Prisma/Postgres no pueden cruzar. */
  const INT64_MAX = 9_223_372_036_854_775_807;

  /** Devuelve el `skip` con el que se llamo a findMany. */
  const skipUsado = (): number =>
    (prisma.hoursTransaction.findMany.mock.calls.at(-1)![0] as { skip: number }).skip;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    email = mockDeep<EmailInvitationService>();
    onboarding = mockDeep<OnboardingService>();
    service = new ClientService(prisma, audit, email, onboarding);

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

    prisma.$transaction.mockResolvedValue([[], 0, { _sum: { priceAmount: null } }] as never);
  });

  // ── El desborde que abria el 500 ──────────────────────

  it('page=1e21 (lo que produce ?page=1e21) se capea y el skip queda muy por debajo de int64 (P1)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT, 1e21, 500);

    expect(result.page).toBe(HOURS_SUMMARY_MAX_PAGE);
    expect(skipUsado()).toBe((HOURS_SUMMARY_MAX_PAGE - 1) * 500);
    expect(skipUsado()).toBeLessThan(INT64_MAX);
    expect(Number.isSafeInteger(skipUsado())).toBe(true);
  });

  it('page=99999999999999999999 (digitos planos: reventaba ANTES del fix del parseo) tambien se capea (P2)', async () => {
    // Este es el caso que demuestra que el agujero nunca fue `parseInt` vs `Number`: los digitos
    // planos siempre cruzaron intactos y siempre desbordaron. El techo cierra los dos caminos.
    const result = await service.getHoursSummary(ORG, CLIENT, 99999999999999999999, 500);

    expect(result.page).toBe(HOURS_SUMMARY_MAX_PAGE);
    expect(skipUsado()).toBeLessThan(INT64_MAX);
  });

  it('page=Number.MAX_VALUE (el peor caso imaginable) sigue dando un skip sano (P3)', async () => {
    await service.getHoursSummary(ORG, CLIENT, Number.MAX_VALUE, 500);

    expect(skipUsado()).toBeLessThan(INT64_MAX);
    expect(Number.isSafeInteger(skipUsado())).toBe(true);
  });

  it('page=Infinity no se cuela por el techo (P4)', async () => {
    // Infinity nunca deberia llegar desde el borde HTTP (el helper del controller lo descarta),
    // pero el clamp del service es defensa en profundidad para OTROS llamadores.
    const result = await service.getHoursSummary(ORG, CLIENT, Infinity, 500);

    expect(result.page).toBe(HOURS_SUMMARY_MAX_PAGE);
    expect(Number.isFinite(skipUsado())).toBe(true);
  });

  // ── El techo se combina con el techo del limit ────────

  it('page y limit maximos a la vez: el skip peor caso sigue siendo seguro (P5)', async () => {
    // El techo de page se eligio DERIVADO del techo del limit justamente para que este producto
    // —el maximo posible— no pueda desbordar. Si alguien sube uno de los dos, este test avisa.
    await service.getHoursSummary(ORG, CLIENT, HOURS_SUMMARY_MAX_PAGE, HOURS_SUMMARY_MAX_LIMIT);

    const peorSkip = (HOURS_SUMMARY_MAX_PAGE - 1) * HOURS_SUMMARY_MAX_LIMIT;
    expect(skipUsado()).toBe(peorSkip);
    expect(peorSkip).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(peorSkip).toBeLessThan(INT64_MAX);
  });

  // ── No-regresion: la paginacion real no se toca ───────

  it('el piso de 1 sigue vigente: page=0 y page=-5 caen en la pagina 1 (P6)', async () => {
    const cero = await service.getHoursSummary(ORG, CLIENT, 0, 20);
    expect(cero.page).toBe(1);
    expect(skipUsado()).toBe(0);

    const negativo = await service.getHoursSummary(ORG, CLIENT, -5, 20);
    expect(negativo.page).toBe(1);
    expect(skipUsado()).toBe(0);
  });

  it('paginas reales pasan intactas: page=3 limit=20 ⇒ skip 40 (P7)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT, 3, 20);

    expect(result.page).toBe(3);
    expect(skipUsado()).toBe(40);
  });

  it('la ultima pagina permitida no se recorta: page=HOURS_SUMMARY_MAX_PAGE pasa tal cual (P8)', async () => {
    const result = await service.getHoursSummary(ORG, CLIENT, HOURS_SUMMARY_MAX_PAGE, 20);

    expect(result.page).toBe(HOURS_SUMMARY_MAX_PAGE);
  });
});
