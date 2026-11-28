import type { IsoDate } from '../shared/dates.ts';
import type { SpotifyTrack } from '../spotify/index.ts';
import type { SpotifyPlaylistClient, PlaylistInfo } from '../spotify/playlist-client.ts';
import { InMemoryTrackRepository } from '../tracks/in-memory-repository.ts';
import type { DailyTrack } from '../tracks/types.ts';
import { playlistYear } from './eligibility.ts';
import { InMemoryPlaylistState } from './state.ts';
import { syncPlaylists, type SyncReport } from './sync.ts';

export interface RehearsalInput {
  playlists: SpotifyPlaylistClient;
  /** Playlist de ensayo de la cuenta autorizada. */
  playlistId: string;
  /** IDs registrados como playlists anuales: nunca se usan para ensayar. */
  protectedPlaylistIds: readonly string[];
  /** Canciones de prueba, ajenas al lote editorial. */
  sample: readonly DailyTrack[];
  /**
   * IDs de Spotify del catálogo real que todavía no pueden estar en una playlist pública (fecha
   * posterior al corte con el reloj real). La playlist de ensayo es pública: el scope autorizado es
   * `playlist-modify-public`, así que una muestra con estas canciones las revelaría antes de tiempo.
   */
  reservedTrackIds: readonly string[];
  /** Reloj simulado: decide qué fechas de la muestra son elegibles (corte D+1 12:00 UTC). */
  now: Date;
  dryRun: boolean;
}

export interface RehearsalReport {
  playlist: PlaylistInfo;
  /** Primera pasada: agrega lo elegible que falte. */
  first: SyncReport;
  /** Segunda pasada sobre la playlist real: no debe agregar nada (sin duplicados). */
  second: SyncReport | null;
}

export class RehearsalRefusedError extends Error {}

/** Nombre con la forma de una playlist anual (`Daywave AAAA`): nunca se ensaya sobre ella. */
const ANNUAL_NAME_PATTERN = /^daywave\s+\d{4}\b/i;

/**
 * Ensayo controlado de la sincronización contra una playlist de prueba: el mismo `syncPlaylists`
 * y el mismo cliente de Spotify que en producción, pero con la muestra en memoria y el registro
 * de la playlist apuntando a la de ensayo, así nunca crea ni toca la playlist anual ni la tabla.
 * Comprueba antes que la playlist sea de la cuenta autorizada y que no sea una anual registrada.
 */
export async function rehearsePlaylistSync({
  playlists,
  playlistId,
  protectedPlaylistIds,
  sample,
  reservedTrackIds,
  now,
  dryRun,
}: RehearsalInput): Promise<RehearsalReport> {
  if (protectedPlaylistIds.includes(playlistId)) {
    throw new RehearsalRefusedError(`${playlistId} is a registered annual playlist`);
  }
  // Cada año se reconcilia por separado: con varios años en la misma playlist el orden se mezclaría.
  if (new Set(sample.map((track) => playlistYear(track.date))).size > 1) {
    throw new RehearsalRefusedError('the sample must belong to a single year');
  }
  const reserved = new Set(reservedTrackIds);
  const leaked = sample.filter((track) => reserved.has(track.spotifyTrackId));
  if (leaked.length > 0) {
    throw new RehearsalRefusedError(
      `the sample contains upcoming catalog tracks (${leaked.map((t) => t.date).join(', ')}): use tracks outside the editorial batch`,
    );
  }
  const [playlist, me] = await Promise.all([
    playlists.describe(playlistId),
    playlists.currentUserId(),
  ]);
  if (ANNUAL_NAME_PATTERN.test(playlist.name.trim())) {
    throw new RehearsalRefusedError(`playlist ${playlistId} is named "${playlist.name}" (annual)`);
  }
  if (playlist.isPublic === false) {
    // Sin `playlist-modify-private` no se puede escribir: mejor un rechazo claro que un 403.
    throw new RehearsalRefusedError(
      `playlist ${playlistId} is private; the test playlist must be public`,
    );
  }
  if (playlist.ownerId !== me) {
    throw new RehearsalRefusedError(
      `playlist ${playlistId} belongs to ${playlist.ownerId}, not to the authorized account ${me}`,
    );
  }

  const state = new InMemoryPlaylistState();
  for (const year of new Set(sample.map((track) => playlistYear(track.date)))) {
    await state.savePlaylist({
      year,
      playlistId,
      url: playlist.url,
      createdAt: now.toISOString(),
    });
  }
  const dependencies = {
    tracks: new InMemoryTrackRepository([...sample]),
    state,
    playlists,
    now: () => now,
  };
  const first = await syncPlaylists(dependencies, { dryRun });
  const second = dryRun ? null : await syncPlaylists(dependencies);
  return { playlist, first, second };
}

/** Playlist de ensayo por defecto. Pública porque el scope autorizado es `playlist-modify-public`. */
export const TEST_PLAYLIST_NAME = 'Daywave - Test';
export const TEST_PLAYLIST_DESCRIPTION =
  'Playlist de prueba de Daywave para ensayar la sincronización. No es la playlist anual.';

/**
 * Busca la playlist de ensayo por nombre entre las de la cuenta autorizada y, si falta y se va a
 * escribir, la crea pública. En dry-run no crea nada y devuelve null. Nunca acepta un nombre con la
 * forma de la playlist anual (`Daywave AAAA`).
 */
export async function resolveTestPlaylist(
  playlists: SpotifyPlaylistClient,
  { name = TEST_PLAYLIST_NAME, dryRun }: { name?: string; dryRun: boolean },
): Promise<{ id: string; created: boolean } | null> {
  if (ANNUAL_NAME_PATTERN.test(name.trim())) {
    throw new RehearsalRefusedError(`"${name}" is an annual playlist name`);
  }
  const existing = await playlists.findOwnedByName(name);
  if (existing) return { id: existing.id, created: false };
  if (dryRun) return null;
  const created = await playlists.create({
    name,
    description: TEST_PLAYLIST_DESCRIPTION,
    isPublic: true,
  });
  return { id: created.id, created: true };
}

/** Muestra integrada: canciones conocidas, ajenas al lote editorial, que se resuelven en Spotify. */
export const BUILT_IN_SAMPLE = [
  { title: 'Bohemian Rhapsody', artist: 'Queen' },
  { title: 'Billie Jean', artist: 'Michael Jackson' },
  { title: 'Smells Like Teen Spirit', artist: 'Nirvana' },
] as const;
/** Fechas sintéticas de la muestra y reloj por defecto: entran las dos primeras, no la tercera. */
export const BUILT_IN_SAMPLE_DATES = ['2027-01-01', '2027-01-02', '2027-01-03'] as const;
export const DEFAULT_REHEARSAL_NOW = '2027-01-03T12:30:00Z';

/** Convierte un resultado de Spotify en una canción de muestra con fecha sintética. */
export function sampleTrack(track: SpotifyTrack, date: IsoDate, now: Date): DailyTrack {
  return {
    date,
    title: track.title,
    artist: track.artist,
    album: track.album,
    releaseYear: track.releaseYear,
    spotifyTrackId: track.id,
    spotifyUrl: `https://open.spotify.com/track/${track.id}`,
    spotifyArtistId: track.artistId,
    selectionCriterion: 'manual',
    description:
      'Canción de muestra para ensayar la sincronización de la playlist; no forma parte del catálogo.',
    createdAt: now.toISOString(),
  };
}
