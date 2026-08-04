import { calculateBusinessDeadline } from './sla.util';

/**
 * Tests de paridad por zona para el fix de timezone de `calculateBusinessDeadline`
 * (feature #17, bug F-C). Funciones puras: sin DB, sin Prisma, sin mocks.
 *
 * El fix usa el truco convert-in/convert-out con `Intl.DateTimeFormat` (zero-dep):
 * convierte el instante UTC al wall-clock de la zona del negocio, corre el algoritmo
 * en wall-clock y al final reconvierte a UTC. ESE TRUCO ASUME que el proceso corre
 * en UTC (como Railway en prod), porque `getHours()/setHours()/getDate()` leen la
 * zona del proceso. Para que la suite sea DETERMINISTA en cualquier máquina/CI sin
 * importar la zona local, se fuerza `process.env.TZ = 'UTC'` (replica del entorno
 * Railway). Sin esto, correr el test en una máquina con TZ=America/Asuncion daría
 * resultados distintos (doble conversión) — el bug que justamente arreglamos.
 *
 * Los asserts se basan en el INSTANTE UTC real del deadline (oráculo robusto,
 * independiente del offset estacional/DST de Paraguay), no en un offset fijo. Para
 * legibilidad, cada caso documenta la hora local de Asunción esperada en comentario.
 */

const TZ_ASUNCION = 'America/Asuncion';

const CONFIG = {
  start: '08:30',
  end: '17:30',
  days: [1, 2, 3, 4, 5], // lunes a viernes
  timezone: TZ_ASUNCION,
};

// Formatea un instante en la hora local de Asunción (para legibilidad/diagnóstico).
function formatInAsuncion(date: Date): string {
  return new Intl.DateTimeFormat('es-PY', {
    timeZone: TZ_ASUNCION,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

describe('calculateBusinessDeadline — fix timezone (feature #17, bug F-C)', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    // El proceso corre en UTC en producción (Railway). Se replica para que el
    // convert-in/out sea determinista en cualquier máquina/CI (ver doc del archivo).
    process.env.TZ = 'UTC';
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it('REGRESIÓN #1: ticket a las 15:05 Asunción (dentro de horario) vence el MISMO día, no al siguiente', () => {
    // start = viernes 19:05 UTC = wall-clock de Asunción dentro de la jornada laboral.
    // +60 min de SLA → debe vencer el mismo viernes, NO empujarse al día siguiente.
    // Este es el bug F-C: antes 19:05 se interpretaba como UTC > 17:30 → día siguiente.
    const start = new Date('2026-06-19T19:05:00Z');
    const deadline = calculateBusinessDeadline(start, 60, CONFIG);

    // 60 min después, dentro de la misma jornada → mismo día, 1h más tarde.
    expect(deadline.toISOString()).toBe('2026-06-19T20:05:00.000Z');
    // Sanidad: el deadline cae el mismo viernes (no salta de día).
    expect(formatInAsuncion(deadline)).toContain('vie');
  });

  it('#2 antes de apertura: arranca a las 08:00 Asunción + 30 → 09:00 Asunción', () => {
    // 11:00 UTC = 08:00 Asunción (antes de 08:30) → el inicio se mueve a 08:30, +30 = 09:00.
    const start = new Date('2026-06-19T11:00:00Z');
    const deadline = calculateBusinessDeadline(start, 30, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-19T12:00:00.000Z'); // 09:00 Asunción
  });

  it('#3 después de cierre: jueves 18:00 Asunción + 60 → viernes 09:30 Asunción', () => {
    // 22:00 UTC jueves = 19:00 Asunción (después de 17:30) → salta al viernes 08:30, +60 = 09:30.
    const start = new Date('2026-06-18T22:00:00Z');
    const deadline = calculateBusinessDeadline(start, 60, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-19T12:30:00.000Z'); // viernes 09:30 Asunción
  });

  it('#4 borde apertura 08:30: arranca exactamente a las 08:30 + 60 → 09:30', () => {
    // 11:30 UTC = 08:30 Asunción exacto → cuenta desde ahí, +60 = 09:30.
    const start = new Date('2026-06-19T11:30:00Z');
    const deadline = calculateBusinessDeadline(start, 60, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-19T12:30:00.000Z'); // 09:30 Asunción
  });

  it('#5 borde cierre 17:30 (excluido): arranca a las 17:30 → salta al día hábil siguiente', () => {
    // 20:30 UTC lunes = 17:30 Asunción exacto. El borde 17:30 se trata como fin de
    // jornada (excluido) → salta a martes 08:30, +30 = 09:00.
    const start = new Date('2026-06-15T20:30:00Z');
    const deadline = calculateBusinessDeadline(start, 30, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-16T12:00:00.000Z'); // martes 09:00 Asunción
  });

  it('#6 fin de semana: viernes 17:00 + 480 (8h) cruza el finde → lunes 16:00 Asunción', () => {
    // 20:00 UTC viernes = 17:00 Asunción. Quedan 30 min hoy; el resto cae sábado/domingo
    // (no hábiles) → lunes. 480 - 30 = 450 desde lunes 08:30 = 16:00.
    const start = new Date('2026-06-19T20:00:00Z');
    const deadline = calculateBusinessDeadline(start, 480, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-22T19:00:00.000Z'); // lunes 16:00 Asunción
  });

  it('#7 sábado: arranca un sábado → primer día hábil es lunes 08:30, +60 = 09:30', () => {
    // 14:00 UTC sábado = 11:00 Asunción (sábado no hábil) → lunes 08:30 + 60 = 09:30.
    const start = new Date('2026-06-20T14:00:00Z');
    const deadline = calculateBusinessDeadline(start, 60, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-22T12:30:00.000Z'); // lunes 09:30 Asunción
  });

  it('#8 feriado: martes 16:00 + 120 cruzando el miércoles feriado → jueves 09:00 Asunción', () => {
    // Holiday.date es @db.Date → Prisma lo materializa a medianoche UTC del 17 (miércoles).
    // 19:00 UTC martes = 16:00 Asunción. Quedan 90 min hoy; restan 30 que deberían ir al
    // miércoles, pero es feriado → salta al jueves 08:30, +30 = 09:00.
    const holidays = [new Date('2026-06-17T00:00:00Z')]; // miércoles 17 (medianoche UTC)
    const start = new Date('2026-06-16T19:00:00Z');
    const deadline = calculateBusinessDeadline(start, 120, CONFIG, holidays);
    expect(deadline.toISOString()).toBe('2026-06-18T12:00:00.000Z'); // jueves 09:00 Asunción
  });

  it('#8b feriado off-by-one: el feriado NO se desfasa de día (cierre del off-by-one)', () => {
    // Control: si el feriado se desfasara al martes 16 (off-by-one viejo), el martes no sería
    // hábil y el cálculo daría otro resultado. Acá el feriado es el miércoles 17: martes y
    // jueves SÍ son hábiles. Arranque martes 08:30 + 60 = martes 09:30 (el feriado no afecta).
    const holidays = [new Date('2026-06-17T00:00:00Z')]; // miércoles 17
    const start = new Date('2026-06-16T11:30:00Z'); // martes 08:30 Asunción
    const deadline = calculateBusinessDeadline(start, 60, CONFIG, holidays);
    expect(deadline.toISOString()).toBe('2026-06-16T12:30:00.000Z'); // martes 09:30 (no afectado por el feriado)
  });

  it('#9 cruce intra-jornada: 17:29 + 5 → continúa al día siguiente 08:34 Asunción', () => {
    // 20:29 UTC martes = 17:29 Asunción. Queda 1 min hoy (hasta 17:30); los 4 restantes
    // continúan al miércoles 08:30 → 08:34.
    const start = new Date('2026-06-16T20:29:00Z');
    const deadline = calculateBusinessDeadline(start, 5, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-17T11:34:00.000Z'); // miércoles 08:34 Asunción
  });

  it('#10 multi-día: 08:30 + 1080 min (2 jornadas de 9h) → fin de la 2ª jornada', () => {
    // 11:30 UTC lunes = 08:30 Asunción. La jornada dura 9h = 540 min. 1080 = 2 jornadas
    // exactas. Lunes consume 540 (08:30→17:30, fin de jornada); martes consume los otros
    // 540 → martes 17:30 (el instante 17:30 como FIN del SLA es válido).
    const start = new Date('2026-06-15T11:30:00Z');
    const deadline = calculateBusinessDeadline(start, 1080, CONFIG);
    expect(deadline.toISOString()).toBe('2026-06-16T20:30:00.000Z'); // martes 17:30 Asunción
  });

  it('default fallback: sin timezone usa America/Asuncion (no la zona del proceso)', () => {
    // Sin config → DEFAULT_BUSINESS_HOURS (timezone America/Asuncion). Mismo caso #1.
    const start = new Date('2026-06-19T19:05:00Z');
    const deadline = calculateBusinessDeadline(start, 60);
    expect(deadline.toISOString()).toBe('2026-06-19T20:05:00.000Z');
  });

  it('guard timezone inválido: cae a America/Asuncion sin lanzar RangeError', () => {
    // Una zona IANA inexistente no debe romper el cálculo (Intl tiraría RangeError):
    // el guard cae a America/Asuncion → mismo resultado que el caso #1.
    const start = new Date('2026-06-19T19:05:00Z');
    const config = { ...CONFIG, timezone: 'Mars/Olympus_Mons' };
    expect(() => calculateBusinessDeadline(start, 60, config)).not.toThrow();
    const deadline = calculateBusinessDeadline(start, 60, config);
    expect(deadline.toISOString()).toBe('2026-06-19T20:05:00.000Z');
  });
});
