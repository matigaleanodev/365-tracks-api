export type SpotifyAuthFailure = 'invalid_grant' | 'invalid_client' | 'unavailable';

/**
 * Falla de autenticación con Spotify. `invalid_grant` significa que el refresh token del dueño
 * venció (dura seis meses desde la autorización original) o fue revocado: hay que repetir la
 * autorización inicial; reintentar no sirve.
 */
export class SpotifyAuthError extends Error {
  readonly failure: SpotifyAuthFailure;

  constructor(failure: SpotifyAuthFailure, message: string) {
    super(message);
    this.name = 'SpotifyAuthError';
    this.failure = failure;
  }
}

export class SpotifyTrackNotFoundError extends Error {
  constructor(trackId: string) {
    super(`Spotify track ${trackId} was not found`);
    this.name = 'SpotifyTrackNotFoundError';
  }
}

/** Spotify respondió, pero sin los metadatos obligatorios para una canción publicable. */
export class SpotifyMetadataError extends Error {
  constructor(what: string) {
    super(`Spotify returned incomplete or invalid metadata for ${what}`);
    this.name = 'SpotifyMetadataError';
  }
}
