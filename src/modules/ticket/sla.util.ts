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

function getBusinessMinutesInDay(config: BusinessHours): number {
  const start = parseTime(config.start);
  const end = parseTime(config.end);
  return (end.hours * 60 + end.minutes) - (start.hours * 60 + start.minutes);
}

function isBusinessDay(date: Date, config: BusinessHours, holidays?: Date[]): boolean {
  // JS getDay: 0=Sun, convert to ISO: 1=Mon...7=Sun
  const jsDay = date.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  if (!config.days.includes(isoDay)) return false;

  // Check if date is a holiday
  if (holidays?.length) {
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return !holidays.some((h) => {
      const hStr = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
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

  let remaining = totalMinutes;
  const cursor = new Date(startTime);

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

  return cursor;
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
