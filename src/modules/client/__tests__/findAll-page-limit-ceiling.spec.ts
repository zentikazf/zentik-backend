import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  ClientService,
  CLIENT_LIST_MAX_LIMIT,
  CLIENT_LIST_MAX_PAGE,
} from '../client.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { EmailInvitationService } from '../../../infrastructure/email/email-invitation.service';
import { OnboardingService } from '../../auth/onboarding/onboarding.service';

/**
 * #57 (cierre) — techos de `page` y `limit` en findAll.
 *
 * POR QUE ESTE ARCHIVO EXISTE APARTE de findAll-query-params.spec.ts: aquel prueba el SANEO del
 * controller (basura sintactica: 'abc', '', '0.5', '10abc') y valores chicos. Toda esa suite
 * quedaba VERDE con dos 500 vivos, porque los numeros de abajo son sintacticamente VALIDOS y
 * cruzan el helper del controller intactos:
 *
 *   A.1  GET .../clients?page=99999999999999999999  ⇒ skip ≈ 5e21 ⇒ Prisma
 *        "Unable to fit value into a 64-bit signed integer for field `skip`" ⇒ HTTP 500.
 *   A.2  GET .../clients?limit=1e21                 ⇒ take gigante ⇒ el mismo 500.
 *        Y ?limit=1000000, que NO revienta, devuelve la tabla `client` ENTERA con
 *        `_count.projects` + `user` + `users` en una sola respuesta.
 *
 * Por eso los tests llaman al SERVICE directo (Prisma mockeado): el agujero estaba ahi, no en el
 * borde HTTP, y el techo tiene que cubrir a cualquier llamador. Lo que se verifica es el par
 * (skip, take) que cruza la frontera hacia Prisma: si esos dos numeros son sanos, no hay 500
 * posible ni respuesta sin acotar.
 */
describe('ClientService — techos de page y limit en findAll (#57 cierre)', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let service: ClientService;

  const ORG = 'org-1';

  /** Techo de un entero con signo de 64 bits: el limite que Prisma/Postgres no pueden cruzar. */
  const INT64_MAX = 9_223_372_036_854_775_807;

  /** Args con los que se llamo a client.findMany. */
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

  // ── A.1: el desborde de `page` ────────────────────────

  it('page=99999999999999999999 (digitos planos, el caso reportado) se capea y el skip queda muy por debajo de int64 (A1)', async () => {
    const result = await service.findAll(ORG, { page: 99999999999999999999 });

    expect(result.page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(argsFindMany().skip).toBe((CLIENT_LIST_MAX_PAGE - 1) * 50);
    expect(argsFindMany().skip).toBeLessThan(INT64_MAX);
    expect(Number.isSafeInteger(argsFindMany().skip)).toBe(true);
  });

  it('page=1e21 tampoco desborda (A2)', async () => {
    const result = await service.findAll(ORG, { page: 1e21 });

    expect(result.page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(argsFindMany().skip).toBeLessThan(INT64_MAX);
    expect(Number.isSafeInteger(argsFindMany().skip)).toBe(true);
  });

  it('page=Number.MAX_VALUE e Infinity siguen dando un skip finito y sano (A3)', async () => {
    await service.findAll(ORG, { page: Number.MAX_VALUE });
    expect(argsFindMany().skip).toBeLessThan(INT64_MAX);
    expect(Number.isSafeInteger(argsFindMany().skip)).toBe(true);

    const result = await service.findAll(ORG, { page: Infinity });
    expect(result.page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(Number.isFinite(argsFindMany().skip)).toBe(true);
  });

  // ── A.2: el desborde y el volcado de `limit` ──────────

  it('limit=1e21 se capea: el take deja de ser un numero absurdo (A4)', async () => {
    const result = await service.findAll(ORG, { limit: 1e21 });

    expect(argsFindMany().take).toBe(CLIENT_LIST_MAX_LIMIT);
    expect(result.limit).toBe(CLIENT_LIST_MAX_LIMIT);
    expect(argsFindMany().take).toBeLessThan(INT64_MAX);
  });

  it('limit=1000000 NO devuelve la tabla entera: se recorta al techo (A5)', async () => {
    // Este es el caso que no reventaba y por eso nadie lo veia: un `take` valido pero enorme
    // devolvia todos los clientes de la organizacion con `_count.projects` + `user` + `users`.
    const result = await service.findAll(ORG, { limit: 1_000_000 });

    expect(argsFindMany().take).toBe(CLIENT_LIST_MAX_LIMIT);
    expect(result.limit).toBe(CLIENT_LIST_MAX_LIMIT);
  });

  // ── Los dos techos combinados ─────────────────────────

  it('page y limit maximos a la vez: el peor skip posible sigue siendo seguro (A6)', async () => {
    // El techo de page se eligio DERIVADO del techo del limit para que este producto —el maximo
    // posible— no pueda desbordar. Si alguien sube cualquiera de los dos, este test avisa.
    await service.findAll(ORG, { page: 1e21, limit: 1e21 });

    const peorSkip = (CLIENT_LIST_MAX_PAGE - 1) * CLIENT_LIST_MAX_LIMIT;
    expect(argsFindMany()).toMatchObject({ skip: peorSkip, take: CLIENT_LIST_MAX_LIMIT });
    expect(peorSkip).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(peorSkip).toBeLessThan(INT64_MAX);
  });

  // ── No-regresion: el uso real no se toca ──────────────

  it('el limit que piden las 5 pantallas del front (?limit=200) pasa intacto (A7)', async () => {
    const result = await service.findAll(ORG, { limit: 200 });

    expect(argsFindMany().take).toBe(200);
    expect(result.limit).toBe(200);
  });

  it('la ultima pagina y el ultimo limit permitidos no se recortan (A8)', async () => {
    const result = await service.findAll(ORG, {
      page: CLIENT_LIST_MAX_PAGE,
      limit: CLIENT_LIST_MAX_LIMIT,
    });

    expect(result.page).toBe(CLIENT_LIST_MAX_PAGE);
    expect(result.limit).toBe(CLIENT_LIST_MAX_LIMIT);
  });

  it('el piso sigue vigente: page=0 y page=-5 caen en la pagina 1 (A9)', async () => {
    const cero = await service.findAll(ORG, { page: 0 });
    expect(cero.page).toBe(1);
    expect(argsFindMany().skip).toBe(0);

    const negativo = await service.findAll(ORG, { page: -5 });
    expect(negativo.page).toBe(1);
    expect(argsFindMany().skip).toBe(0);
  });

  it('paginas reales pasan intactas: page=3 limit=25 ⇒ skip 50 (A10)', async () => {
    const result = await service.findAll(ORG, { page: 3, limit: 25 });

    expect(argsFindMany()).toMatchObject({ skip: 50, take: 25 });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(25);
  });

  it('los techos del listado son PROPIOS, no los del ledger de horas (A11)', () => {
    // Guard de diseno: si alguien "simplifica" con
    //   export const CLIENT_LIST_MAX_LIMIT = HOURS_SUMMARY_MAX_LIMIT;
    // este test tiene que ROJEAR. Son dos cosas distintas (padron de clientes vs ledger de un
    // cliente) y tienen que poder moverse por separado.
    //
    // POR QUE SE MIRA EL CODIGO FUENTE Y NO LOS VALORES: los dos pares VALEN LO MISMO hoy
    // (500 / 100_000), asi que ninguna comparacion de valores en runtime distingue "dos
    // constantes propias que coinciden" de "una aliaseada a la otra" — con el alias aplicado
    // `CLIENT_LIST_MAX_LIMIT !== HOURS_SUMMARY_MAX_LIMIT` seria FALSO y el guard pasaria igual.
    // La propiedad que SI las distingue es la FORMA DE LA DECLARACION: una constante propia se
    // declara con su propio literal numerico; una aliaseada se declara nombrando a la otra. Eso
    // solo se ve en el texto del modulo, no en los numeros que exporta.
    const fuente = readFileSync(join(__dirname, '..', 'client.service.ts'), 'utf8');

    for (const nombre of ['CLIENT_LIST_MAX_LIMIT', 'CLIENT_LIST_MAX_PAGE']) {
      const declaracion = new RegExp(`^export const ${nombre}\\s*=\\s*(.+);\\s*$`, 'm').exec(
        fuente,
      )?.[1];

      expect(declaracion).toBeDefined();
      // Literal numerico propio (admite el separador de miles `_`): nada de identificadores,
      // ni expresiones derivadas de otra constante.
      expect(declaracion).toMatch(/^\d[\d_]*$/);
      expect(declaracion).not.toContain('HOURS_SUMMARY');
    }

    // Y ademas los valores tienen que seguir sirviendo para lo suyo.
    expect(CLIENT_LIST_MAX_LIMIT).toBeGreaterThanOrEqual(200); // las 5 pantallas piden 200
    expect((CLIENT_LIST_MAX_PAGE - 1) * CLIENT_LIST_MAX_LIMIT).toBeLessThan(INT64_MAX);
  });
});
