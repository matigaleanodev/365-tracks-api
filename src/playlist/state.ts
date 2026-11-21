import type { IsoDate } from '../shared/dates.ts';

export interface PlaylistRecord {
  year: number;
  playlistId: string;
  url: string;
  createdAt: string;
}

export interface SyncedEntry {
  date: IsoDate;
  spotifyTrackId: string;
  syncedAt: string;
}

/**
 * Estado local de la sincronización: qué playlist anual existe y qué fechas ya se resolvieron.
 * Es una caché de decisiones, no la fuente de verdad del contenido: la playlist real se lee
 * de Spotify antes de agregar, así una caída entre escribir y registrar no duplica nada.
 */
export interface PlaylistStateRepository {
  getPlaylist(year: number): Promise<PlaylistRecord | null>;
  /** Escritura condicional: la primera playlist registrada para el año es la que vale. */
  savePlaylist(record: PlaylistRecord): Promise<'created' | 'already-exists'>;
  listSynced(year: number): Promise<SyncedEntry[]>;
  /** Idempotente: registrar dos veces la misma fecha deja el mismo resultado. */
  markSynced(year: number, entries: readonly SyncedEntry[]): Promise<void>;
}

export class InMemoryPlaylistState implements PlaylistStateRepository {
  readonly #playlists = new Map<number, PlaylistRecord>();
  readonly #synced = new Map<number, Map<IsoDate, SyncedEntry>>();

  getPlaylist(year: number): Promise<PlaylistRecord | null> {
    return Promise.resolve(this.#playlists.get(year) ?? null);
  }

  savePlaylist(record: PlaylistRecord): Promise<'created' | 'already-exists'> {
    if (this.#playlists.has(record.year)) return Promise.resolve('already-exists');
    this.#playlists.set(record.year, record);
    return Promise.resolve('created');
  }

  listSynced(year: number): Promise<SyncedEntry[]> {
    return Promise.resolve([...(this.#synced.get(year)?.values() ?? [])]);
  }

  markSynced(year: number, entries: readonly SyncedEntry[]): Promise<void> {
    const byDate = this.#synced.get(year) ?? new Map<IsoDate, SyncedEntry>();
    for (const entry of entries) byDate.set(entry.date, entry);
    this.#synced.set(year, byDate);
    return Promise.resolve();
  }
}
