import type { IsoDate } from '../shared/dates.ts';

/** Primera fecha editorial pública (calendario UTC). Nada anterior se expone por la API. */
export const PUBLICATION_START_DATE: IsoDate = '2027-01-01';

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
