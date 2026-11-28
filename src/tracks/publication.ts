import { getEditorialDate, type IsoDate } from '../shared/dates.ts';

/** Primera fecha editorial pública (calendario UTC). Nada anterior se expone por la API. */
export const PUBLICATION_START_DATE: IsoDate = '2027-01-01';

/** La zona más adelantada (UTC+14) es la primera en empezar cada fecha. */
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

/**
 * Una canción es pública desde el inicio de su fecha editorial UTC y nunca antes del
 * lanzamiento: una canción elegida por adelantado no se ve hasta que llega su día.
 */
export function isPublishedDate(
  date: IsoDate,
  today: IsoDate,
  start: IsoDate = PUBLICATION_START_DATE,
): boolean {
  return date >= start && date <= today;
}

/** Fecha más reciente que ya empezó en alguna zona horaria (la de UTC+14) en el instante `now`. */
export function latestStartedDate(now: Date): IsoDate {
  return getEditorialDate(new Date(now.getTime() + MAX_UTC_OFFSET_MS));
}

/**
 * Si la fecha ya pudo verse en alguna zona. Las operaciones del operador que reemplazan o borran
 * una canción solo se permiten antes de este punto: después la canción ya es pública para alguien.
 */
export function isPublicSomewhere(
  date: IsoDate,
  now: Date,
  start: IsoDate = PUBLICATION_START_DATE,
): boolean {
  return isPublishedDate(date, latestStartedDate(now), start);
}
