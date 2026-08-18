import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientController } from '../client.controller';
import { ClientService } from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #57 fix C — el mismo bug de `?limit=abc`, 120 lineas mas arriba en el MISMO controller.
 *
 * `findAll` hacia `page ? Number(page) : undefined` / `limit ? Number(limit) : undefined`.
 * `Number('abc')` es NaN, y en el service `params.limit ?? 50` NO atrapa NaN (`??` solo cubre
 * null/undefined). Aca era PEOR que en getHoursSummary: findAll no tiene ningun clamp, asi que
 * NaN no tenia segunda defensa y Prisma recibia `take: NaN`
 * ⇒ "Argument `take` is missing." ⇒ HTTP 500.
 *
 * El fix reusa el helper que ya existia en el archivo. Se testea en dos niveles:
 *  - CONTROLLER: que valor cruza la frontera (service mockeado).
 *  - SERVICE: que ese `undefined` efectivamente cae en el default de la firma (Prisma mockeado),
 *    porque el fix solo sirve si el otro lado lo interpreta bien.
 */
describe('ClientController — saneo de page/limit en findAll (#57)', () => {
  let service: DeepMockProxy<ClientService>;
  let controller: ClientController;

  const ORG = 'org-1';

  /** Devuelve el objeto `params` tal como lo recibio el service. */
  const paramsFor = (page?: string, limit?: string) => {
    controller.findAll(ORG, undefined, page, limit);
    return service.findAll.mock.calls.at(-1)![1];
  };

  beforeEach(() => {
    service = mockDeep<ClientService>();
    service.findAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 } as never);
    controller = new ClientController(service);
  });

  it('?limit=abc NO propaga NaN: llega undefined (F1)', () => {
    const params = paramsFor(undefined, 'abc');

    expect(params.limit).toBeUndefined();
    expect(params.limit).not.toBeNaN();
  });

  it('?page=abc NO propaga NaN: llega undefined (F2)', () => {
    const params = paramsFor('abc', undefined);

    expect(params.page).toBeUndefined();
    expect(params.page).not.toBeNaN();
  });

  it.each([
    ['vacio', ''],
    ['solo espacios', '   '],
    ['cero', '0'],
    ['negativo', '-5'],
    ['decimal en (0,1)', '0.5'],
    ['Infinity', 'Infinity'],
    ['numero con sufijo', '10abc'],
  ])('?limit=%s cae al default (F3)', (_caso, valor) => {
    const params = paramsFor(undefined, valor);

    expect(params.limit).toBeUndefined();
  });

  it('valores validos siguen pasando: ?page=2&limit=25 (F4)', () => {
    const params = paramsFor('2', '25');

    expect(params.page).toBe(2);
    expect(params.limit).toBe(25);
  });

  it('sin query params llegan undefined, como antes (F5)', () => {
    const params = paramsFor(undefined, undefined);

    expect(params.page).toBeUndefined();
    expect(params.limit).toBeUndefined();
  });
});

describe('ClientService — findAll interpreta el undefined del controller (#57)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: ClientService;

  const ORG = 'org-1';

  const argsFindMany = (): { skip: number; take: number } =>
    prisma.client.findMany.mock.calls.at(-1)![0] as never;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new ClientService(
      prisma,
      mockDeep<AuditService>(),
      mockDeep<EmailInvitationService>(),
      mockDeep<OnboardingService>(),
    );

    // $transaction([findMany, count]) → sin clientes.
    prisma.$transaction.mockResolvedValue([[], 0] as never);
  });

  it('page/limit undefined ⇒ entran los defaults de la firma (1 y 50) (F6)', async () => {
    const result = await service.findAll(ORG, { page: undefined, limit: undefined });

    expect(argsFindMany().take).toBe(50);
    expect(argsFindMany().skip).toBe(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });

  it('sin la clave page/limit en el objeto tambien entran los defaults (F7)', async () => {
    const result = await service.findAll(ORG, {});

    expect(argsFindMany().take).toBe(50);
    expect(result.limit).toBe(50);
  });

  it('take y skip nunca son NaN con la entrada saneada del controller (F8)', async () => {
    // La regresion concreta: con `Number('abc')` el service recibia NaN, `?? 50` no lo atrapaba
    // y Prisma respondia "Argument `take` is missing." (500). Con undefined esto no puede pasar.
    await service.findAll(ORG, { page: undefined, limit: undefined });

    expect(argsFindMany().take).not.toBeNaN();
    expect(argsFindMany().skip).not.toBeNaN();
  });

  it('valores validos se respetan: page=2 limit=25 ⇒ skip 25 (F9)', async () => {
    const result = await service.findAll(ORG, { page: 2, limit: 25 });

    expect(argsFindMany()).toMatchObject({ skip: 25, take: 25 });
    expect(result.page).toBe(2);
  });
});
