import type { MusicSelector } from '../music-selection/index.ts';
import type { IsoDate } from '../shared/dates.ts';
import type { SpotifyClient } from '../spotify/index.ts';
import { findIncompleteFields, IncompleteTrackError } from './completeness.ts';
import type { TrackRepository } from './repository.ts';
import type { DailyTrack } from './types.ts';

export interface GenerateDailyTrackDependencies {
  repository: TrackRepository;
  selector: MusicSelector;
  spotify: SpotifyClient;
  now: () => Date;
}

export interface GenerateDailyTrackResult {
  status: 'created' | 'already-exists';
  track: DailyTrack;
}

/**
 * Idempotente por fecha: si ya hay canción no consulta selección ni Spotify, y la
 * escritura condicional del repositorio cubre la carrera entre dos ejecuciones.
 */
export async function generateDailyTrack(
  { repository, selector, spotify, now }: GenerateDailyTrackDependencies,
  date: IsoDate,
): Promise<GenerateDailyTrackResult> {
  const existing = await repository.getByDate(date);
  if (existing) {
    return { status: 'already-exists', track: existing };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await selectAndStore(
      { repository, selector, spotify, now },
      date,
      attempt === MAX_ATTEMPTS,
    );
    if (result) return result;
  }
  throw new Error(`Track for ${date} could not be stored`);
}

/** Intentos si otra ejecución ocupó la canción o el artista entre la selección y la escritura. */
const MAX_ATTEMPTS = 3;

async function selectAndStore(
  { repository, selector, spotify, now }: GenerateDailyTrackDependencies,
  date: IsoDate,
  last: boolean,
): Promise<GenerateDailyTrackResult | null> {
  const selection = await selector.select(date);
  const metadata = await spotify.getTrack(selection.spotifyTrackId);

  const track: DailyTrack = {
    date,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    releaseYear: metadata.releaseYear,
    spotifyTrackId: metadata.id,
    spotifyUrl: metadata.url,
    selectionCriterion: selection.selectionCriterion,
    description: selection.description,
    spotifyArtistId: metadata.artistId,
    createdAt: now().toISOString(),
  };
  if (metadata.coverUrl !== undefined) {
    track.coverUrl = metadata.coverUrl;
  }

  // Nunca se escribe una canción incompleta: la fecha queda libre para un reintento.
  const incomplete = findIncompleteFields(track);
  if (incomplete.length > 0) {
    throw new IncompleteTrackError(date, incomplete);
  }

  const outcome = await repository.create(track);
  if (outcome === 'created') {
    return { status: 'created', track };
  }
  if (outcome !== 'already-exists') {
    // Una ejecución concurrente ocupó esa canción o artista: se vuelve a seleccionar con el
    // catálogo actualizado. Nada se guardó, así que no queda rastro de la elegida.
    if (last)
      throw new Error(`Track for ${date} conflicts with a concurrent selection (${outcome})`);
    return null;
  }
  const winner = await repository.getByDate(date);
  if (!winner) {
    throw new Error(`Track for ${date} reported as existing but could not be read`);
  }
  return { status: 'already-exists', track: winner };
}
