import { addDays, type IsoDate } from '../shared/dates.ts';
import { findIncompleteFields } from './completeness.ts';
import { isPublicSomewhere, PUBLICATION_START_DATE } from './publication.ts';
import { readAllTracks } from './read-all.ts';
import type { TrackRepository } from './repository.ts';

/**
 * - `published`: completa y su fecha ya empezó en alguna zona (solo se corrige la nota).
 * - `prepared`: completa y todavía oculta (se puede reemplazar).
 * - `incomplete`: le faltan campos o la nota; la API no la publica ni la playlist la agrega.
 */
export type CatalogEntryStatus = 'published' | 'prepared' | 'incomplete';

export interface CatalogEntry {
  date: IsoDate;
  status: CatalogEntryStatus;
  title: string;
  artist: string;
  spotifyTrackId: string;
  description: string | undefined;
  /** Campos faltantes o inválidos (vacío salvo en `incomplete`). */
  missingFields: string[];
}

export interface CatalogListing {
  entries: CatalogEntry[];
  /** Fechas sin canción entre el lanzamiento y la última fecha cargada. */
  gaps: IsoDate[];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Todo el catálogo en orden cronológico, con el estado de cada fecha. Solo lee; incluye fechas
 * futuras, así que es exclusivamente para el operador (nunca para la API pública).
 */
export async function listCatalog(
  repository: Pick<TrackRepository, 'list'>,
  now: Date,
): Promise<CatalogListing> {
  const tracks = (await readAllTracks(repository)).sort((a, b) => a.date.localeCompare(b.date));
  const entries = tracks.map((track): CatalogEntry => {
    const missingFields = findIncompleteFields(track);
    const status: CatalogEntryStatus =
      missingFields.length > 0
        ? 'incomplete'
        : isPublicSomewhere(track.date, now)
          ? 'published'
          : 'prepared';
    return {
      date: track.date,
      status,
      title: text(track.title),
      artist: text(track.artist),
      spotifyTrackId: text(track.spotifyTrackId),
      description: typeof track.description === 'string' ? track.description : undefined,
      missingFields,
    };
  });

  const dates = new Set(entries.map((entry) => entry.date));
  const gaps: IsoDate[] = [];
  const last = entries.at(-1)?.date;
  if (last !== undefined) {
    for (let date = PUBLICATION_START_DATE; date <= last; date = addDays(date, 1)) {
      if (!dates.has(date)) gaps.push(date);
    }
  }
  return { entries, gaps };
}
