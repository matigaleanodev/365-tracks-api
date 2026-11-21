import { randomUUID } from 'node:crypto';
import type { IsoDate } from '../shared/dates.ts';
import { DEFAULT_HTTP_POLICY } from '../shared/resilient-fetch.ts';
import {
  AmbiguousSpotifyWriteError,
  type SpotifyPlaylistClient,
  type WriteGuard,
} from '../spotify/playlist-client.ts';
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
  /**
   * Instante absoluto (epoch ms) en que la Lambda deja de ejecutarse. El presupuesto de escritura
   * es el menor entre el vencimiento del candado y este valor.
   */
  deadlineMs?: number;
}

export interface YearSyncReport {
  year: number;
  playlistId: string | null;
  /** Dry-run sin playlist registrada: se crearía (o reutilizaría) al sincronizar. */
  wouldCreatePlaylist: boolean;
  /** Fechas agregadas (o que se agregarían en dry-run) a la playlist. */
  added: IsoDate[];
  /** Fechas cuya canción ya estaba en la playlist pero no estaba registrada (escritura previa). */
  adopted: IsoDate[];
  /** Canciones de la playlist que no son del catálogo elegible: nunca se tocan, solo se cuentan. */
  external: number;
}

export interface SyncReport {
  /** Última fecha elegible según el reloj: nada posterior se toca. */
  lastEligible: IsoDate;
  dryRun: boolean;
  years: YearSyncReport[];
  /** Elegibles por fecha pero incompletas: no se agregan hasta corregirlas. */
  skippedIncomplete: IsoDate[];
  /** Años omitidos porque otra ejecución tiene el candado vigente. */
  skippedLocked: number[];
}

/** Vence solo si la ejecución muere; la función dura como máximo 120 s. */
export const LOCK_TTL_MS = 5 * 60 * 1000;
/**
 * Margen antes del vencimiento: ninguna escritura empieza si el candado vence en menos que esto
 * (una escritura en vuelo puede tardar hasta su timeout). Así nunca se escribe con el candado perdido.
 */
export const LEASE_SAFETY_MS = 30_000;

// Una escritura en vuelo dura como máximo su timeout: el margen tiene que superarlo.
if (LEASE_SAFETY_MS <= DEFAULT_HTTP_POLICY.timeoutMs) {
  throw new Error('LEASE_SAFETY_MS must exceed the write timeout');
}

/** Una escritura no puede empezar sin margen: el candado o la Lambda vencen antes de que termine. */
export class WriteBudgetExhaustedError extends Error {
  constructor(year: number) {
    super(`Write budget for ${year} exhausted: aborting before writing`);
    this.name = 'WriteBudgetExhaustedError';
  }
}

/**
 * Guard de escritura: lanza si un intento que empieza en `startsInMs` no deja al menos
 * `LEASE_SAFETY_MS` antes del límite (el menor entre candado y deadline de la Lambda).
 */
function createWriteGuard(year: number, now: () => Date, limitMs: number): WriteGuard {
  return (startsInMs) => {
    if (limitMs - (now().getTime() + startsInMs) < LEASE_SAFETY_MS) {
      throw new WriteBudgetExhaustedError(year);
    }
  };
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

/** Un grupo de IDs contiguos a insertar: sin `position` se agrega al final. */
interface InsertOp {
  position?: number;
  trackIds: string[];
}

/**
 * Decide dónde va cada canción faltante para conservar el orden cronológico: detrás de la última
 * canción conocida anterior; si no hay, delante de la primera posterior; si no hay ninguna
 * conocida, al final. Las canciones ajenas del catálogo no se mueven ni se borran.
 */
function planInsertions(
  present: readonly (string | null)[],
  missing: readonly DailyTrack[],
  dateOf: ReadonlyMap<string, IsoDate>,
): InsertOp[] {
  const current: (string | null)[] = [...present];
  const ops: InsertOp[] = [];
  let last: { op: InsertOp; next: number } | undefined;
  for (const track of missing) {
    let position = -1;
    let firstLater = -1;
    current.forEach((id, index) => {
      const date = id === null ? undefined : dateOf.get(id);
      if (date === undefined) return;
      if (date < track.date) position = index + 1;
      else if (firstLater === -1) firstLater = index;
    });
    if (position === -1) position = firstLater === -1 ? current.length : firstLater;
    const append = position === current.length;
    current.splice(position, 0, track.spotifyTrackId);
    if (last && !append && last.op.position !== undefined && position === last.next) {
      last.op.trackIds.push(track.spotifyTrackId);
      last.next += 1;
    } else if (last && append && last.op.position === undefined) {
      last.op.trackIds.push(track.spotifyTrackId);
    } else {
      const op: InsertOp = append
        ? { trackIds: [track.spotifyTrackId] }
        : { position, trackIds: [track.spotifyTrackId] };
      ops.push(op);
      last = { op, next: position + 1 };
    }
  }
  return ops;
}

/**
 * Concilia la playlist anual con el catálogo elegible y completo.
 *
 * La fuente de verdad es la playlist real en Spotify, no `synced`: se lee en cada ejecución, de
 * modo que una canción borrada a mano, una escritura parcial o un cambio externo se detectan y
 * se recuperan sin duplicar. Solo se agregan canciones elegibles y completas, en orden
 * cronológico; lo que otra persona haya puesto en la playlist nunca se borra ni se reordena.
 */
async function reconcileYear(
  { state, playlists, now }: SyncDependencies,
  year: number,
  yearTracks: readonly DailyTrack[],
  lastEligible: IsoDate,
  dryRun: boolean,
  limitMs: number,
): Promise<YearSyncReport | null> {
  assertEligible(yearTracks, lastEligible);
  const guard = createWriteGuard(year, now, limitMs);
  const report: YearSyncReport = {
    year,
    playlistId: null,
    wouldCreatePlaylist: false,
    added: [],
    adopted: [],
    external: 0,
  };

  let record = await state.getPlaylist(year);
  if (!record) {
    if (dryRun) {
      report.wouldCreatePlaylist = true;
      report.added = yearTracks.map((track) => track.date);
      return report;
    }
    // Reutilizar antes de crear: una caída tras crear, antes de guardar el ID, no duplica la playlist.
    const ref =
      (await playlists.findOwnedByName(playlistName(year))) ??
      (await playlists.create(
        { name: playlistName(year), description: playlistDescription(year), isPublic: true },
        guard,
      ));
    const created = { year, playlistId: ref.id, url: ref.url, createdAt: now().toISOString() };
    record =
      (await state.savePlaylist(created)) === 'created' ? created : await state.getPlaylist(year);
    if (!record) throw new Error(`Playlist record for ${year} could not be read`);
  }
  report.playlistId = record.playlistId;

  const present = await playlists.listItems(record.playlistId);
  const presentSet = new Set(present.filter((id): id is string => id !== null));
  const dateOf = new Map(yearTracks.map((track) => [track.spotifyTrackId, track.date]));
  report.external = present.filter((id) => id === null || !dateOf.has(id)).length;

  const synced = new Map(
    (await state.listSynced(year)).map((entry) => [entry.date, entry.spotifyTrackId]),
  );
  const queued = new Set<string>();
  const missing: DailyTrack[] = [];
  for (const track of yearTracks) {
    if (presentSet.has(track.spotifyTrackId)) {
      if (!synced.has(track.date)) report.adopted.push(track.date);
    } else if (!queued.has(track.spotifyTrackId)) {
      queued.add(track.spotifyTrackId);
      missing.push(track);
      report.added.push(track.date);
    }
  }
  if (dryRun) return report;

  for (const op of planInsertions(present, missing, dateOf)) {
    // El guard corta antes de cada bloque y de cada reintento si falta margen.
    await playlists.addTracks(record.playlistId, op.trackIds, op.position, guard);
  }
  const syncedAt = now().toISOString();
  const entries: SyncedEntry[] = yearTracks
    // También cuando el catálogo cambió el ID de una fecha ya registrada.
    .filter(
      (track) =>
        synced.get(track.date) !== track.spotifyTrackId || queued.has(track.spotifyTrackId),
    )
    .map((track) => ({ date: track.date, spotifyTrackId: track.spotifyTrackId, syncedAt }));
  if (entries.length > 0) await state.markSynced(year, entries);
  return report;
}

/**
 * Sincroniza las playlists anuales con las canciones de días que ya terminaron en todas las
 * zonas. Idempotente y recuperable (ver `reconcileYear`); independiente de la preparación del
 * catálogo. Un candado con vencimiento por año evita escrituras simultáneas: si otra ejecución
 * lo tiene, ese año se omite y se informa. En dry-run no escribe nada ni toma el candado.
 *
 * Presupuesto: ningún POST empieza (ni se reintenta tras esperar) con menos de `LEASE_SAFETY_MS`
 * hasta el menor entre el candado y `deadlineMs`. Una escritura ambigua corta el año y conserva el
 * candado hasta su vencimiento; la siguiente ejecución relee la playlist real y adopta.
 */
export async function syncPlaylists(
  dependencies: SyncDependencies,
  { dryRun = false, deadlineMs = Infinity }: SyncOptions = {},
): Promise<SyncReport> {
  const { tracks, state, now } = dependencies;
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
  const skippedLocked: number[] = [];
  for (const [year, yearTracks] of byYear) {
    let report: YearSyncReport | null;
    if (dryRun) {
      report = await reconcileYear(dependencies, year, yearTracks, lastEligible, true, Infinity);
    } else {
      const owner = randomUUID();
      const acquiredAt = now().getTime();
      if (!(await state.acquireLock(year, owner, acquiredAt, LOCK_TTL_MS))) {
        skippedLocked.push(year);
        continue;
      }
      // Si Spotify pudo aplicar una escritura sin avisar, el candado no se libera: vence solo.
      let keepLock = false;
      try {
        report = await reconcileYear(
          dependencies,
          year,
          yearTracks,
          lastEligible,
          false,
          Math.min(acquiredAt + LOCK_TTL_MS, deadlineMs),
        );
      } catch (error) {
        keepLock = error instanceof AmbiguousSpotifyWriteError;
        throw error;
      } finally {
        if (!keepLock) await state.releaseLock(year, owner);
      }
    }
    if (report && (report.added.length > 0 || report.adopted.length > 0)) years.push(report);
  }

  return { lastEligible, dryRun, years, skippedIncomplete, skippedLocked };
}
