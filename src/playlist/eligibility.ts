import { addDays, getEditorialDate, type IsoDate } from '../shared/dates.ts';
import { PUBLICATION_START_DATE } from '../tracks/publication.ts';

/**
 * Hora UTC desde la cual terminó el día D en todas las zonas: el último huso (UTC−12) termina
 * D a las 12:00 UTC de D+1. Antes de ese instante la canción de D todavía es "la del día" para
 * alguien, y la playlist solo contiene canciones de días anteriores.
 */
export const PLAYLIST_CUTOFF_UTC_HOUR = 12;

const HOUR_MS = 3_600_000;

/**
 * Última fecha editorial elegible en el instante `now`: la fecha D más reciente tal que
 * `now >= D+1 12:00 UTC`. Solo depende del reloj en UTC, nunca de la zona de quien ejecuta.
 */
export function lastEligibleDate(now: Date): IsoDate {
  const shifted = new Date(now.getTime() - PLAYLIST_CUTOFF_UTC_HOUR * HOUR_MS);
  return addDays(getEditorialDate(shifted), -1);
}

/** Una canción asignada a `date` puede entrar a la playlist desde las 12:00 UTC de D+1. */
export function isEligibleForPlaylist(
  date: IsoDate,
  now: Date,
  start: IsoDate = PUBLICATION_START_DATE,
): boolean {
  return date >= start && date <= lastEligibleDate(now);
}

/** La playlist anual corresponde al año de la fecha editorial, no al del momento de la sincronización. */
export function playlistYear(date: IsoDate): number {
  return Number(date.slice(0, 4));
}

export const playlistName = (year: number) => `Daywave ${year}`;

export const playlistDescription = (year: number) =>
  `Una canción por día de Daywave ${year}. Se agregan canciones de días anteriores, nunca la del día.`;
