import type { IsoDate } from '../shared/dates.ts';
import { artistIdentity } from '../tracks/artist-key.ts';
import type { TrackConflict } from '../tracks/repository.ts';
import type { DailyTrack } from '../tracks/types.ts';
import { recordingKeyOf } from './recording-key.ts';

/** Días mínimos entre dos canciones del mismo artista principal (antes y después). */
export const DEFAULT_ARTIST_COOLDOWN_DAYS = 60;

/** Lo mínimo que las reglas necesitan de una canción: sirve para candidatas y guardadas. */
export interface TrackIdentity {
  id: string;
  title: string;
  artist: string;
  artistId: string | undefined;
}

export const identityOf = (track: DailyTrack): TrackIdentity => ({
  id: track.spotifyTrackId,
  title: track.title,
  artist: track.artist,
  artistId: track.spotifyArtistId,
});

export type RuleViolation = TrackConflict;

interface ArtistEntry {
  date: IsoDate;
  artistId: string | undefined;
  artistKey: string;
}

export interface HistoryIndex {
  trackIds: Set<string>;
  /** Título base + artista: detecta la misma canción publicada con otro ID de Spotify. */
  recordings: Set<string>;
  artists: ArtistEntry[];
}

const DAY_MS = 86_400_000;
const daysBetween = (a: IsoDate, b: IsoDate) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

/** Índice de todo lo ya preparado o publicado, pasado y futuro. */
export function buildHistory(tracks: readonly DailyTrack[]): HistoryIndex {
  return {
    trackIds: new Set(tracks.map((track) => track.spotifyTrackId)),
    recordings: new Set(tracks.map((track) => recordingKeyOf(track.title, track.artist))),
    artists: tracks.map((track) => ({
      date: track.date,
      artistId: track.spotifyArtistId,
      artistKey: artistIdentity(track.artist),
    })),
  };
}

/**
 * Reglas de no repetición para la canción candidata de `date`:
 * - nunca una canción ya elegida (por ID de Spotify, o por título + artista si cambió el ID);
 * - nunca el mismo artista principal a menos de `cooldownDays` de otra fecha, hacia atrás o hacia
 *   adelante. Coincide por ID de Spotify o por identidad del nombre (normalizado): el ID solo no alcanza
 *   (cargas manuales sin ID, perfiles duplicados del mismo artista).
 */
export function findViolation(
  candidate: TrackIdentity,
  date: IsoDate,
  history: HistoryIndex,
  cooldownDays: number = DEFAULT_ARTIST_COOLDOWN_DAYS,
): RuleViolation | null {
  if (history.trackIds.has(candidate.id)) return 'duplicate-track';
  if (history.recordings.has(recordingKeyOf(candidate.title, candidate.artist))) {
    return 'duplicate-recording';
  }
  const artistKey = artistIdentity(candidate.artist);
  const sameArtist = history.artists.some(
    (entry) =>
      ((candidate.artistId !== undefined && entry.artistId === candidate.artistId) ||
        entry.artistKey === artistKey) &&
      daysBetween(entry.date, date) < cooldownDays,
  );
  return sameArtist ? 'artist-cooldown' : null;
}
