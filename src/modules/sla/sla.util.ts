interface BusinessHours {
  start: string; // "08:30"
  end: string;   // "17:30"
  days: number[]; // [1,2,3,4,5] (1=Mon...7=Sun)
  timezone: string;
}

const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  start: '08:30',
  end: '17:30',
  days: [1, 2, 3, 4, 5],
  timezone: 'America/Asuncion',
};

function parseTime(time: string): { hours: number; minutes: number } {
  const [hours, minutes] = time.split(':').map(Number);
  return { hours, minutes };
}

// Zona por defecto: el server corre en UTC (Railway), pero el negocio opera
// en hora de Asunción. Se usa como fallback ante timezone vacío/inválido.
const DEFAULT_TIMEZONE = 'America/Asuncion';

/**
 * Devuelve el offset (en minutos) del wall-clock de `timeZone` respecto a UTC
 * para el instante `date`. Es negativo para zonas al oeste de UTC (ej. -240
 * para UTC-4, la hora estándar de Paraguay).
 *
 * Implementación zero-dep con `Intl.DateTimeFormat` (nativo, soporta IANA + DST):
 * formatea el instante en la zona, reconstruye ese wall-clock como si fuera UTC
 * (`Date.UTC`) y le resta el instante real. La diferencia es exactamente el offset.
 *
 * Se usa para el truco convert-in/convert-out de `calculateBusinessDeadline`:
 * `new Date(utc.getTime() + tzOffsetMinutes(utc, tz) * 60000)` produce un Date
 * cuyo `getHours()` (que el server lee en UTC) devuelve la hora local de la zona.
 *
 * Guard: si `timeZone` es falsy o `Intl` tira `RangeError` (zona inválida),
 * cae a `America/Asuncion` para no romper el cálculo del deadline.
 */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const tz = timeZone || DEFAULT_TIMEZONE;
  try {
    return computeTzOffsetMinutes(date, tz);
  } catch {
    // Zona inválida (RangeError de Intl) → fallback seguro a la zona del negocio.
    return computeTzOffsetMinutes(date, DEFAULT_TIMEZONE);
  }
}

function computeTzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    p[part.type] = part.value;
  }
  // hour12:false puede devolver "24" para medianoche en algunos engines → normalizar a 0.
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

function getBusinessMinutesInDay(config: BusinessHours): number {
  const start = parseTime(config.start);
  const end = parseTime(config.end);
  return (end.hours * 60 + end.minutes) - (start.hours * 60 + start.minutes);
}

function isBusinessDay(date: Date, config: BusinessHours, holidays?: Date[]): boolean {
  // El `date` (cursor) ya viene en wall-clock local (convert-in de
  // calculateBusinessDeadline): sus getDay/getDate ya están en la zona del negocio.
  // JS getDay: 0=Sun, convert to ISO: 1=Mon...7=Sun
  const jsDay = date.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  if (!config.days.includes(isoDay)) return false;

  // Check if date is a holiday
  if (holidays?.length) {
    // El `date` (cursor) ya está en wall-clock local de la zona (convert-in), y el
    // proceso corre en UTC (Railway) → getFullYear/getMonth/getDate leen ese
    // wall-clock como fecha-calendario de la zona.
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return !holidays.some((h) => {
      // Holiday.date es @db.Date (fecha pura): Prisma la materializa a medianoche
      // UTC (ej. 2026-06-17T00:00:00Z para el feriado del 17). Su fecha-calendario
      // correcta se lee en UTC; convertirla a la zona la desfasaría un día
      // (off-by-one). Se compara fecha-calendario vs fecha-calendario.
      const hStr = `${h.getUTCFullYear()}-${String(h.getUTCMonth() + 1).padStart(2, '0')}-${String(h.getUTCDate()).padStart(2, '0')}`;
      return hStr === dateStr;
    });
  }

  return true;
}

export function calculateBusinessDeadline(
  startTime: Date,
  totalMinutes: number,
  config?: Partial<BusinessHours>,
  holidays?: Date[],
): Date {
  const bh: BusinessHours = {
    ...DEFAULT_BUSINESS_HOURS,
    ...config,
  };

  const startParsed = parseTime(bh.start);
  const endParsed = parseTime(bh.end);
  const startOfDayMinutes = startParsed.hours * 60 + startParsed.minutes;
  const endOfDayMinutes = endParsed.hours * 60 + endParsed.minutes;
  const dailyMinutes = getBusinessMinutesInDay(bh);

  // Zona del negocio (guard contra timezone vacío/inválido en tzOffsetMinutes).
  const tz = bh.timezone || DEFAULT_TIMEZONE;

  let remaining = totalMinutes;

  // Convert-in: pasar el instante UTC al wall-clock de la zona del negocio.
  // El `cursor` resultante, leído con getHours()/getDate() (que el server lee en
  // UTC), devuelve la HORA LOCAL de la zona — así el algoritmo de abajo opera en
  // wall-clock coherente con bh.start/bh.end ("08:30"-"17:30"), sin tocar su lógica.
  const cursor = new Date(startTime.getTime() + tzOffsetMinutes(startTime, tz) * 60000);

  // If start is outside business hours, move to next business start
  const cursorMinutes = cursor.getHours() * 60 + cursor.getMinutes();
  if (!isBusinessDay(cursor, bh, holidays) || cursorMinutes >= endOfDayMinutes) {
    // Move to next day's start
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(startParsed.hours, startParsed.minutes, 0, 0);
    while (!isBusinessDay(cursor, bh, holidays)) {
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (cursorMinutes < startOfDayMinutes) {
    cursor.setHours(startParsed.hours, startParsed.minutes, 0, 0);
  }

  while (remaining > 0) {
    if (!isBusinessDay(cursor, bh, holidays)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(startParsed.hours, startParsed.minutes, 0, 0);
      continue;
    }

    const currentMinutes = cursor.getHours() * 60 + cursor.getMinutes();
    const minutesLeftToday = endOfDayMinutes - currentMinutes;

    if (minutesLeftToday <= 0) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(startParsed.hours, startParsed.minutes, 0, 0);
      continue;
    }

    if (remaining <= minutesLeftToday) {
      cursor.setMinutes(cursor.getMinutes() + remaining);
      remaining = 0;
    } else {
      remaining -= minutesLeftToday;
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(startParsed.hours, startParsed.minutes, 0, 0);
    }
  }

  // Convert-out: el cursor representa el wall-clock local de la zona (almacenado
  // como-si-UTC). Se recupera el instante UTC real restando el offset. Se recalcula
  // el offset sobre el cursor final porque puede diferir del inicial por DST si el
  // deadline cae en otro huso horario estacional que el startTime.
  const outOffset = tzOffsetMinutes(cursor, tz);
  return new Date(cursor.getTime() - outOffset * 60000);
}

export function getSlaProgress(createdAt: Date, deadline: Date): number {
  const now = new Date();
  const total = deadline.getTime() - createdAt.getTime();
  if (total <= 0) return 100;
  const elapsed = now.getTime() - createdAt.getTime();
  return Math.min(100, Math.round((elapsed / total) * 100));
}

export function parseBusinessDays(daysString: string): number[] {
  return daysString.split(',').map(Number).filter((n) => n >= 1 && n <= 7);
}

// ────────────────────────────────────────────────────────────────────────
// SLA outcome helpers (feature #9 — dashboard tickets breakdown)
// ────────────────────────────────────────────────────────────────────────

export type SlaOutcome =
  | 'COMPLIED'
  | 'BREACHED_RESPONSE'
  | 'BREACHED_RESOLUTION'
  | 'BREACHED_BOTH'
  | 'NO_SLA'
  | 'IN_FLIGHT';

/**
 * Calcula minutos de exceso entre completedAt y deadline.
 * - Devuelve null si falta cualquiera de los inputs (no hay SLA o aun no completado).
 * - Devuelve 0 si llego a tiempo (completedAt <= deadline).
 * - Devuelve >0 si hubo overshoot.
 */
export function calculateSlaOvershoot(
  deadline: Date | null | undefined,
  completedAt: Date | null | undefined,
): number | null {
  if (!deadline || !completedAt) return null;
  const diffMs = completedAt.getTime() - deadline.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 60000);
}

export interface TicketSlaShape {
  status: string;
  responseDeadline: Date | null;
  resolutionDeadline: Date | null;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaResponseBreached: boolean;
  slaResolutionBreached: boolean;
}

/**
 * Clasifica el desenlace SLA de un ticket.
 *
 * Reglas (ver requirements.md R8 — feature #9):
 * - NO_SLA: sin responseDeadline ni resolutionDeadline.
 * - BREACHED_BOTH: ambas flags de breach en true.
 * - BREACHED_RESPONSE / BREACHED_RESOLUTION: solo una en true.
 * - IN_FLIGHT: estado no terminal (OPEN/IN_PROGRESS/IN_REVIEW) sin breach todavia.
 * - COMPLIED: estado RESOLVED sin breaches (llego a tiempo).
 */
export function classifySlaOutcome(ticket: TicketSlaShape): SlaOutcome {
  const noResponseSla = ticket.responseDeadline === null;
  const noResolutionSla = ticket.resolutionDeadline === null;
  if (noResponseSla && noResolutionSla) return 'NO_SLA';

  const respBreach = ticket.slaResponseBreached;
  const resoBreach = ticket.slaResolutionBreached;
  if (respBreach && resoBreach) return 'BREACHED_BOTH';
  if (respBreach) return 'BREACHED_RESPONSE';
  if (resoBreach) return 'BREACHED_RESOLUTION';

  const isTerminal = ticket.status === 'RESOLVED';
  if (!isTerminal) return 'IN_FLIGHT';
  return 'COMPLIED';
}
