import { NotImplementedError } from '../shared/errors.ts';
import type { TimeBudget } from '../shared/time-budget.ts';

export interface SpotifyArtistRef {
  id: string;
  name: string;
}

export type ReleaseDatePrecision = 'year' | 'month' | 'day';

export interface SpotifyTrack {
  id: string;
  title: string;
  /** Artista principal (el primero que informa Spotify). */
  artist: string;
  artistId: string;
  artists: SpotifyArtistRef[];
  album: string;
  albumType?: string;
  releaseYear: number;
  /** Tal como lo informa Spotify: `YYYY`, `YYYY-MM` o `YYYY-MM-DD` según la precisión. */
  releaseDate: string;
  releaseDatePrecision: ReleaseDatePrecision;
  url: string;
  coverUrl?: string;
}

export interface SpotifySearchQuery {
  title: string;
  artist: string;
}

export interface SpotifyCallOptions {
  budget?: TimeBudget;
}

/** Catálogo de Spotify: consultas de solo lectura, sin credenciales de usuario. */
export interface SpotifyClient {
  getTrack(trackId: string, options?: SpotifyCallOptions): Promise<SpotifyTrack>;
  /** Candidatos crudos; decidir cuál es la canción correcta es tarea de `matching.ts`. */
  searchTracks(query: SpotifySearchQuery, options?: SpotifyCallOptions): Promise<SpotifyTrack[]>;
}

export const notImplementedSpotifyClient: SpotifyClient = {
  getTrack: () => Promise.reject(new NotImplementedError('Spotify integration')),
  searchTracks: () => Promise.reject(new NotImplementedError('Spotify integration')),
};

export { SpotifyAuthError, SpotifyTrackNotFoundError, SpotifyMetadataError } from './errors.ts';
