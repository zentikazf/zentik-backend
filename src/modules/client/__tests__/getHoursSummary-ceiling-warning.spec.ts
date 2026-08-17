import { Logger } from '@nestjs/common';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  ClientService,
  HOURS_SUMMARY_MAX_LIMIT,
  HOURS_SUMMARY_WARN_THRESHOLD,
} from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #56 — aviso cuando el ledger de un cliente se acerca al techo de getHoursSummary.
 *
 * Regla: la vista de cards del staff agrupa y suma EN EL NAVEGADOR, asi que necesita el ledger
 * COMPLETO. El dia que un cliente cruce el techo (#53) los totales por mes vuelven a mentir, y el
 * modo de falla es SILENCIOSO. El warn existe para que ese cruce no pase desapercibido.
 * La salida correcta cuando salte NO es subir el techo: es paginar por MES agrupando en SQL.
 *
 * W1: por debajo del umbral ⇒ NO hay warn (un warn que aparece siempre deja de leerse).
 * W2: por encima del umbral y por debajo del techo ⇒ hay warn con el clientId y el conteo.
 * W3: el umbral se DERIVA del techo — el test lo CALCULA desde `HOURS_SUMMARY_MAX_LIMIT` en vez de
 *     hardcodear 400. Si hardcodeara, no protegeria de nada: es exactamente el bug que la constante
 *     derivada previene (subir el techo y dejar el umbral muerto).
 * Prisma MOCKEADO — nunca toca la DB.
 */
describe('ClientService — aviso al acercarse al techo del ledger (#56)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let audit: DeepMockProxy<AuditService>;
  let email: DeepMockProxy<EmailInvitationService>;
  let onboarding: DeepMockProxy<OnboardingService>;
  let service: ClientService;
  let warnSpy: jest.SpyInstance;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** Deja el `count` del $transaction en el conteo pedido (la tupla es [findMany, count, aggregate]). */
  const conConteo = (total: number) => {
    prisma.$transaction.mockResolvedValue([[], total, { _sum: { priceAmount: null } }] as never);
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    email = mockDeep<EmailInvitationService>();
    onboarding = mockDeep<OnboardingService>();
    service = new ClientService(prisma, audit, email, onboarding);

    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

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

    conConteo(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('por debajo del umbral no emite ningún warn (W1)', async () => {
    conConteo(HOURS_SUMMARY_WARN_THRESHOLD - 1);

    await service.getHoursSummary(ORG, CLIENT, 1, HOURS_SUMMARY_MAX_LIMIT);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('justo EN el umbral tampoco avisa: el aviso es al CRUZARLO (W1)', async () => {
    conConteo(HOURS_SUMMARY_WARN_THRESHOLD);

    await service.getHoursSummary(ORG, CLIENT, 1, HOURS_SUMMARY_MAX_LIMIT);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('por encima del umbral y por debajo del techo avisa con clientId y conteo (W2)', async () => {
    const total = HOURS_SUMMARY_WARN_THRESHOLD + 1;
    conConteo(total);

    await service.getHoursSummary(ORG, CLIENT, 1, HOURS_SUMMARY_MAX_LIMIT);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const mensaje = String(warnSpy.mock.calls[0][0]);
    expect(mensaje).toContain(CLIENT);
    expect(mensaje).toContain(String(total));
    expect(mensaje).toContain(String(HOURS_SUMMARY_MAX_LIMIT));
    // La salida correcta tiene que estar en el texto: quien lo lea no debe subir el techo.
    expect(mensaje).toMatch(/paginar por MES/i);
    // El conteo es el de LA VISTA (con `movement` el count lleva el mismo where.type que las filas),
    // asi que el texto no puede afirmar que es lo que tiene el cliente: al filtrar, el numero baja y
    // el aviso desaparece, y quien lo lea lo toma por un error.
    expect(mensaje).toMatch(/vista/i);
    expect(mensaje).not.toMatch(/cliente \S+ tiene/i);
  });

  it('el umbral se DERIVA del techo (80%), no es un literal aparte (W3)', () => {
    // Calculado desde el techo a propósito: si alguien mueve HOURS_SUMMARY_MAX_LIMIT, el umbral
    // tiene que acompañarlo. Hardcodear 400 acá dejaría pasar justo el bug que esto previene.
    expect(HOURS_SUMMARY_WARN_THRESHOLD).toBe(Math.floor(HOURS_SUMMARY_MAX_LIMIT * 0.8));
    expect(HOURS_SUMMARY_WARN_THRESHOLD).toBeLessThan(HOURS_SUMMARY_MAX_LIMIT);
  });

  it('la frontera del warn se mueve con el techo, no con un número fijo (W3)', async () => {
    // Todo se expresa en función del techo: el test sigue siendo válido si el techo cambia.
    const bajoUmbral = Math.floor(HOURS_SUMMARY_MAX_LIMIT * 0.8) - 1;
    conConteo(bajoUmbral);
    await service.getHoursSummary(ORG, CLIENT, 1, HOURS_SUMMARY_MAX_LIMIT);
    expect(warnSpy).not.toHaveBeenCalled();

    const sobreUmbral = Math.floor(HOURS_SUMMARY_MAX_LIMIT * 0.8) + 1;
    conConteo(sobreUmbral);
    await service.getHoursSummary(ORG, CLIENT, 1, HOURS_SUMMARY_MAX_LIMIT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
