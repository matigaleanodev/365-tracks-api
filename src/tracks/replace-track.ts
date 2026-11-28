import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { IsoDate } from '../shared/dates.ts';
import { removeTrack } from './maintenance.ts';
import { conflictMessage } from './manual-load.ts';
import { isPublicSomewhere } from './publication.ts';
import type { TrackRepository } from './repository.ts';
import { parseTrackInput } from './track-input.ts';
import type { DailyTrack } from './types.ts';

export interface ReplaceTrackInput {
  client: DynamoDBDocumentClient;
  tableName: string;
  repository: TrackRepository;
  /** Fecha que se reemplaza: tiene que coincidir con la del archivo. */
  date: IsoDate;
  /** La canción nueva, con el mismo formato que una carga manual. */
  raw: unknown;
  now: Date;
  /** Reloj para volver a evaluar el corte justo antes de la baja (en producción, el real). */
  clock: () => Date;
  /** Sin `write` solo valida y compara: no escribe nada. */
  write: boolean;
}

export type ReplaceTrackResult =
  | { status: 'invalid'; errors: string[] }
  /** La fecha ya empezó en alguna zona: no se toca. */
  | { status: 'published' }
  /** No hay canción en esa fecha: corresponde una carga manual, no un reemplazo. */
  | { status: 'not-found' }
  | { status: 'valid'; previous: DailyTrack; track: DailyTrack }
  | { status: 'replaced'; previous: DailyTrack; track: DailyTrack }
  /**
   * La canción nueva no se guardó (repite canción, grabación o artista, u otro escritor ocupó la
   * fecha). `now` dice qué quedó realmente en la fecha tras intentar devolver la anterior.
   */
  | { status: 'conflict'; errors: string[]; previous: DailyTrack; now: DateOccupant }
  /**
   * Falló el guardado de la nueva (red, throttling): puede haberse escrito igual. `now` dice qué
   * quedó realmente en la fecha, releída después de intentar devolver la anterior.
   */
  | { status: 'error'; error: string; previous: DailyTrack; now: DateOccupant };

/** Lo que hay en la fecha al terminar: la nueva, la anterior, nada u otra canción; `unknown` si no se pudo leer. */
export type DateOccupant = 'new' | 'previous' | 'empty' | 'other' | 'unknown';

/**
 * Reemplaza la canción de una fecha que todavía no empezó en ninguna zona. Reutiliza la baja
 * transaccional (`removeTrack`) y el alta condicional del repositorio, con las mismas reglas de
 * repetición que la carga manual. Si la nueva no se puede guardar, intenta devolver la anterior a
 * su fecha. Correr con los escritores detenidos: la reposición podría ocupar la fecha libre.
 */
export async function replaceTrack({
  client,
  tableName,
  repository,
  date,
  raw,
  now,
  clock,
  write,
}: ReplaceTrackInput): Promise<ReplaceTrackResult> {
  const parsed = parseTrackInput(raw, now);
  if (!parsed.ok) return { status: 'invalid', errors: parsed.errors };
  const track = parsed.track;
  if (track.date !== date) {
    return { status: 'invalid', errors: [`date: the file is for ${track.date}, not ${date}`] };
  }
  if (isPublicSomewhere(date, now)) return { status: 'published' };

  const previous = await repository.getByDate(date);
  if (!previous) return { status: 'not-found' };
  if (!write) return { status: 'valid', previous, track };

  // Igualdad de todo lo persistido: un reemplazo puede conservar el ID de Spotify y cambiar el resto.
  const fields = (value: DailyTrack) =>
    JSON.stringify(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(),
    );
  const same = (a: DailyTrack, b: DailyTrack) => fields(a) === fields(b);

  // Devuelve la anterior si la fecha quedó libre y relee qué quedó: nunca informa a ciegas.
  const settle = async (): Promise<DateOccupant> => {
    try {
      await repository.create(previous);
    } catch {
      // La relectura de abajo decide qué informar.
    }
    try {
      const current = await repository.getByDate(date);
      if (!current) return 'empty';
      if (same(current, track)) return 'new';
      if (same(current, previous)) return 'previous';
      return 'other';
    } catch {
      return 'unknown';
    }
  };

  let removed;
  try {
    removed = await removeTrack(client, tableName, date, {
      now,
      clock,
      // Si otro escritor cambió la fecha después de leer `previous`, no se borra su canción.
      expectedSpotifyTrackId: previous.spotifyTrackId,
    });
  } catch (error) {
    // La baja pudo haberse aplicado (respuesta perdida): misma recuperación que un alta fallida.
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      previous,
      now: await settle(),
    };
  }
  if (removed !== 'removed') return { status: removed };

  let created;
  try {
    created = await repository.create(track);
  } catch (error) {
    const occupant = await settle();
    if (occupant === 'new') return { status: 'replaced', previous, track };
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      previous,
      now: occupant,
    };
  }
  if (created === 'created') return { status: 'replaced', previous, track };

  const errors =
    created === 'already-exists'
      ? ['another writer filled the date while replacing it']
      : [conflictMessage(created)];
  return { status: 'conflict', errors, previous, now: await settle() };
}
