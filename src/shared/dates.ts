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

export function addDays(date: IsoDate, days: number): IsoDate {
  return getEditorialDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_IN_MS));
}
