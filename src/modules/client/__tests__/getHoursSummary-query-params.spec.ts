import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { ClientController } from '../client.controller';
import { ClientService } from '../client.service';

/**
 * #57 — higiene: un `?limit=abc` no puede reventar el endpoint.
 *
 * El bug: el controller hacia `limit ? parseInt(limit, 10) : undefined`. Con `?limit=abc`,
 * `parseInt` devuelve NaN. NaN atraviesa el clamp del service intacto
 * (`Math.min(Math.max(1, NaN), 500)` === NaN), Prisma recibe `take: NaN` y la pantalla
 * se cae con un 500.
 *
 * Nadie de la app manda eso —la vista de tiempo pide siempre `?limit=500`—, pero era una
 * puerta mal cerrada: bastaba editar la URL a mano.
 *
 * El contrato que se fija aca: un valor invalido llega al service como `undefined`, y ahi
 * entra el default de la firma (page = 1, limit = 20 en getHoursSummary; 1 / 50 en findAll).
 * Los clamps del service NO cambiaron: siguen siendo defensa en profundidad para llamadores
 * que no pasen por el controller.
 *
 * Se testea el CONTROLLER (el borde) con el service mockeado: lo que importa es que valor
 * cruza la frontera, no lo que el service haga despues. El techo de `page` que evita el
 * desborde de int64 vive en el service y se testea en getHoursSummary-page-ceiling.spec.ts.
 */
describe('ClientController — saneo de page/limit en getHoursSummary (#57)', () => {
  let service: DeepMockProxy<ClientService>;
  let controller: ClientController;

  const ORG = 'org-1';
  const CLIENT = 'client-1';

  /** Devuelve [page, limit] tal como los recibio el service. */
  const argsFor = (page?: string, limit?: string): [unknown, unknown] => {
    controller.getHoursSummary(ORG, CLIENT, page, limit);
    const call = service.getHoursSummary.mock.calls.at(-1)!;
    return [call[2], call[3]];
  };

  beforeEach(() => {
    service = mockDeep<ClientService>();
    service.getHoursSummary.mockResolvedValue({} as never);
    controller = new ClientController(service);
  });

  // ── El bug original ───────────────────────────────────

  it('?limit=abc NO propaga NaN: llega undefined y entra el default (Q1)', () => {
    const [, limit] = argsFor(undefined, 'abc');

    expect(limit).toBeUndefined();
    expect(limit).not.toBeNaN();
  });

  it('?page=abc NO propaga NaN: llega undefined y entra el default (Q2)', () => {
    const [page] = argsFor('abc', undefined);

    expect(page).toBeUndefined();
    expect(page).not.toBeNaN();
  });

  it('?page=abc&limit=abc: ninguno de los dos propaga NaN (Q3)', () => {
    const [page, limit] = argsFor('abc', 'abc');

    expect(page).toBeUndefined();
    expect(limit).toBeUndefined();
  });

  // ── No-regresion: lo valido sigue igual ───────────────

  it('?limit=500 (lo que pide la vista de tiempo) pasa tal cual (Q4)', () => {
    const [page, limit] = argsFor('1', '500');

    expect(page).toBe(1);
    expect(limit).toBe(500);
  });

  it('?page=3&limit=20 pasan tal cual (Q5)', () => {
    const [page, limit] = argsFor('3', '20');

    expect(page).toBe(3);
    expect(limit).toBe(20);
  });

  it('sin query params llegan undefined, como antes (Q6)', () => {
    const [page, limit] = argsFor(undefined, undefined);

    expect(page).toBeUndefined();
    expect(limit).toBeUndefined();
  });

  it('?limit=501 sigue cruzando sin tocar: capear es tarea del service (Q7)', () => {
    const [, limit] = argsFor(undefined, '501');

    expect(limit).toBe(501);
  });

  // ── Otras formas de basura que tambien caian mal ──────

  it.each([
    ['vacio', ''],
    ['solo espacios', '   '],
    ['cero', '0'],
    ['negativo', '-5'],
    ['Infinity', 'Infinity'],
    ['numero con sufijo', '10abc'],
    ['notacion basura', '1e'],
  ])('?limit=%s cae al default (Q8)', (_caso, valor) => {
    const [, limit] = argsFor(undefined, valor);

    expect(limit).toBeUndefined();
  });

  it('un decimal se trunca hacia abajo (Q9)', () => {
    const [, limit] = argsFor(undefined, '10.9');

    expect(limit).toBe(10);
  });

  // ── El helper cumple su propio contrato ───────────────

  /**
   * #57 fix B: el guard `n > 0` se evaluaba ANTES del truncado, asi que `0.5 > 0` daba true y
   * `Math.trunc(0.5)` devolvia 0 — el valor que el helper promete descartar. Como `0 !== undefined`,
   * el default de la firma del service NO entraba. Sintoma visible: `?limit=0` devolvia 20 filas
   * (default) pero `?limit=0.5` devolvia 1. Dos basuras equivalentes con resultados distintos.
   * Todo el intervalo (0,1) estaba sin cobertura.
   */
  it.each([
    ['0.5', '0.5'],
    ['0.9', '0.9'],
    ['0.0001', '0.0001'],
    ['1e-3 (notacion cientifica en (0,1))', '1e-3'],
  ])('?limit=%s cae al default igual que ?limit=0, no a 0 ni a 1 (Q10)', (_caso, valor) => {
    const [, limit] = argsFor(undefined, valor);

    expect(limit).toBeUndefined();
    expect(limit).not.toBe(0);
  });

  it('?limit=0 y ?limit=0.5 cruzan el MISMO valor: basuras equivalentes, resultado equivalente (Q11)', () => {
    const [, cero] = argsFor(undefined, '0');
    const [, medio] = argsFor(undefined, '0.5');

    expect(medio).toBe(cero);
  });

  it('?page=0.5 tambien cae al default (el helper es el mismo para los dos params) (Q12)', () => {
    const [page] = argsFor('0.5', undefined);

    expect(page).toBeUndefined();
  });

  // ── Sin paridad con parseInt: se documenta lo que el codigo HACE ──

  /**
   * #57 fix D: el JSDoc y este test afirmaban paridad con `parseInt`, y no la hay. `Number` lee el
   * string COMPLETO en vez de cortar en el primer caracter no numerico. El comportamiento nuevo es
   * mas defendible (rechaza lo ambiguo en vez de adivinar), pero el comentario decia otra cosa.
   * Estos casos fijan la conducta REAL para que el proximo que lea el helper no se guie por una
   * promesa falsa.
   */
  it.each([
    ['1e3 → 1000 (parseInt cortaba en la "e" y daba 1)', '1e3', 1000],
    ['0x10 → 16 (parseInt con base 10 daba 0 ⇒ default)', '0x10', 16],
    ['10abc → default (parseInt daba 10)', '10abc', undefined],
    ['"  20 " → 20 (Number ignora el blanco de los bordes)', '  20 ', 20],
  ])('divergencia deliberada con parseInt: %s (Q13)', (_caso, valor, esperado) => {
    const [, limit] = argsFor(undefined, valor as string);

    expect(limit).toBe(esperado);
  });

  it('param repetido (?limit=10&limit=20): Express manda un ARRAY y cae al default (Q14)', () => {
    // La firma dice `string`, pero en runtime Express entrega `['10','20']` cuando el query param
    // viene repetido. `Number(array)` es NaN ⇒ undefined. `parseInt` daba 10 (el primer elemento).
    // Rechazar un input ambiguo es la lectura segura: el peor caso es caer al default, no un 500.
    const [, limit] = argsFor(undefined, ['10', '20'] as unknown as string);

    expect(limit).toBeUndefined();
  });

  /**
   * #57 fix A — por que el techo NO puede vivir en el helper.
   *
   * `?page=1e21` es finito y > 0, asi que el helper lo deja pasar tal cual: 1e21. Y esta bien que
   * lo deje pasar — no es basura sintactica, es un numero absurdamente grande, que es un problema
   * de RANGO, no de parseo. La prueba de que el parseo nunca fue el agujero: `?page=1e21` y
   * `?page=1000000000000000000000` (digitos planos) cruzan EXACTAMENTE el mismo valor por aca.
   * Quien lo frena es el techo del service (HOURS_SUMMARY_MAX_PAGE), no este helper.
   */
  it('?page=1e21 cruza el helper sin frenarse: el techo es tarea del service (Q15)', () => {
    const [cientifica] = argsFor('1e21', undefined);
    const [planos] = argsFor('1000000000000000000000', undefined);

    expect(cientifica).toBe(1e21);
    expect(planos).toBe(1e21);
  });
});
