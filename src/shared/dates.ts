/** Fecha editorial en formato YYYY-MM-DD, siempre calendario UTC. */
export type IsoDate = string;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_IN_MS = 86_400_000;

/** Valida formato y existencia real en el calendario (rechaza 2027-02-30). */
export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().startsWith(value);
}

/** La fecha editorial es la fecha UTC del instante recibido. */
export function getEditorialDate(now: Date): IsoDate {
  return now.toISOString().slice(0, 10);
}

export const DEFAULT_TIME_ZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Devuelve null si `timeZone` no es una zona IANA que el runtime conozca. */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) {
    return cached;
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/**
 * Formato IANA con región (`America/Argentina/Buenos_Aires`) o alias sin barra (`UTC`, `GMT`).
 * Excluye los desplazamientos (`+03:00`) que algunos runtimes aceptan como zona.
 */
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const MAX_TIME_ZONE_LENGTH = 64;

export function isValidTimeZone(value: string): boolean {
  return (
    value.length <= MAX_TIME_ZONE_LENGTH &&
    TIME_ZONE_PATTERN.test(value) &&
    formatterFor(value) !== null
  );
}

/** Fecha del calendario local de `timeZone` en el instante `now` (zona ya validada). */
export function getLocalDate(now: Date, timeZone: string): IsoDate {
  const formatter = formatterFor(timeZone);
  if (!formatter) {
    throw new RangeError(`Invalid time zone: ${timeZone}`);
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return getEditorialDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_IN_MS));
}
