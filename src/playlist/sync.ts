import type { IsoDate } from '../shared/dates.ts';
import type { SpotifyPlaylistClient } from '../spotify/playlist-client.ts';
import { findIncompleteFields } from '../tracks/completeness.ts';
import { PUBLICATION_START_DATE } from '../tracks/publication.ts';
import { readAllTracks } from '../tracks/read-all.ts';
import type { TrackRepository } from '../tracks/repository.ts';
import type { DailyTrack } from '../tracks/types.ts';
import {
  lastEligibleDate,
  playlistDescription,
  playlistName,
  playlistYear,
} from './eligibility.ts';
import type { PlaylistStateRepository, SyncedEntry } from './state.ts';

export interface SyncDependencies {
  /** Solo lectura. */
  tracks: Pick<TrackRepository, 'list'>;
  state: PlaylistStateRepository;
  playlists: SpotifyPlaylistClient;
  now: () => Date;
}

export interface SyncOptions {
  /** Calcula y informa sin crear ni modificar nada en Spotify ni en el estado local. */
  dryRun?: boolean;
}

export interface YearSyncReport {
  year: number;
  playlistId: string | null;
  /** Dry-run sin playlist registrada: se crearía (o reutilizaría) al sincronizar. */
  wouldCreatePlaylist: boolean;
  /** Fechas agregadas (o que se agregarían en dry-run) a la playlist. */
  added: IsoDate[];
  /** Fechas cuya canción ya estaba en la playlist (recuperación tras una escritura previa). */
  adopted: IsoDate[];
}

export interface SyncReport {
  /** Última fecha elegible según el reloj: nada posterior se toca. */
  lastEligible: IsoDate;
  dryRun: boolean;
  years: YearSyncReport[];
  /** Elegibles por fecha pero incompletas: no se agregan hasta corregirlas. */
  skippedIncomplete: IsoDate[];
}

/**
 * Última barrera: aunque el filtro de elegibilidad falle, nada futuro llega a una playlist
 * pública. Una playlist pública con canciones futuras las revelaría a todos.
 */
function assertEligible(tracks: readonly DailyTrack[], lastEligible: IsoDate): void {
  const offending = tracks.find(
    (track) => track.date > lastEligible || track.date < PUBLICATION_START_DATE,
  );
  if (offending) {
    throw new Error(`Refusing to add ${offending.date} to a playlist: it is not eligible yet`);
  }
}

/**
 * Agrega a la playlist anual las canciones de días que ya terminaron en todas las zonas.
 *
 * Idempotente y recuperable: antes de escribir lee la playlist real. Si una ejecución anterior
 * escribió en Spotify y se cayó antes de registrar el resultado, la siguiente adopta esas
 * canciones en vez de duplicarlas. El orden de agregado es cronológico. Es independiente de la
 * preparación del catálogo: solo lee canciones ya completas y elegibles.
 */
export async function syncPlaylists(
  { tracks, state, playlists, now }: SyncDependencies,
  { dryRun = false }: SyncOptions = {},
): Promise<SyncReport> {
  const lastEligible = lastEligibleDate(now());
  const catalog = await readAllTracks(tracks);

  const eligible = catalog
    .filter((track) => track.date >= PUBLICATION_START_DATE && track.date <= lastEligible)
    .sort((a, b) => a.date.localeCompare(b.date));
  const skippedIncomplete = eligible
    .filter((track) => findIncompleteFields(track).length > 0)
    .map((track) => track.date);
  const ready = eligible.filter((track) => findIncompleteFields(track).length === 0);

  const byYear = new Map<number, DailyTrack[]>();
  for (const track of ready) {
    const year = playlistYear(track.date);
    byYear.set(year, [...(byYear.get(year) ?? []), track]);
  }

  const years: YearSyncReport[] = [];
  for (const [year, yearTracks] of byYear) {
    const synced = new Set((await state.listSynced(year)).map((entry) => entry.date));
    const pending = yearTracks.filter((track) => !synced.has(track.date));
    if (pending.length === 0) continue;
    assertEligible(pending, lastEligible);

    const report: YearSyncReport = {
      year,
      playlistId: null,
      wouldCreatePlaylist: false,
      added: [],
      adopted: [],
    };
    years.push(report);

    let record = await state.getPlaylist(year);
    if (!record) {
      if (dryRun) {
        report.wouldCreatePlaylist = true;
        report.added = pending.map((track) => track.date);
        continue;
      }
      // Reutilizar antes de crear: una caída tras crear, antes de guardar el ID, no duplica la playlist.
      const ref =
        (await playlists.findOwnedByName(playlistName(year))) ??
        (await playlists.create({
          name: playlistName(year),
          description: playlistDescription(year),
          isPublic: true,
        }));
      const created = {
        year,
        playlistId: ref.id,
        url: ref.url,
        createdAt: now().toISOString(),
      };
      record =
        (await state.savePlaylist(created)) === 'created' ? created : await state.getPlaylist(year);
      if (!record) throw new Error(`Playlist record for ${year} could not be read`);
    }
    report.playlistId = record.playlistId;

    const present = new Set(await playlists.listTrackIds(record.playlistId));
    const queued = new Set<string>();
    const toAdd: DailyTrack[] = [];
    for (const track of pending) {
      if (present.has(track.spotifyTrackId)) {
        report.adopted.push(track.date);
      } else if (!queued.has(track.spotifyTrackId)) {
        queued.add(track.spotifyTrackId);
        toAdd.push(track);
        report.added.push(track.date);
      }
    }
    if (dryRun) continue;

    if (toAdd.length > 0) {
      await playlists.addTracks(
        record.playlistId,
        toAdd.map((track) => track.spotifyTrackId),
      );
    }
    const syncedAt = now().toISOString();
    const entries: SyncedEntry[] = pending.map((track) => ({
      date: track.date,
      spotifyTrackId: track.spotifyTrackId,
      syncedAt,
    }));
    await state.markSynced(year, entries);
  }

  return { lastEligible, dryRun, years, skippedIncomplete };
}
