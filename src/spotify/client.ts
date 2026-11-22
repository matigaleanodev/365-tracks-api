import {
  DEFAULT_HTTP_POLICY,
  HttpError,
  requestJson,
  type HttpDependencies,
  type HttpPolicy,
} from '../shared/resilient-fetch.ts';
import type { AccessTokenProvider } from './auth.ts';
import { SpotifyMetadataError, SpotifyTrackNotFoundError } from './errors.ts';
import type {
  ReleaseDatePrecision,
  SpotifyArtistRef,
  SpotifyCallOptions,
  SpotifyClient,
  SpotifySearchQuery,
  SpotifyTrack,
} from './index.ts';

export const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
export const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/** En Development Mode la búsqueda admite como máximo 10 resultados por página. */
const SEARCH_LIMIT = 10;
const CACHE_LIMIT = 200;
const RELEASE_DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export interface SpotifyClientOptions {
  tokens: AccessTokenProvider;
  policy?: HttpPolicy;
  http?: HttpDependencies;
  baseUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function parseArtists(value: unknown): SpotifyArtistRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((artist) => {
    if (!isRecord(artist)) return [];
    const id = nonEmptyString(artist.id);
    const name = nonEmptyString(artist.name);
    return id !== undefined && SPOTIFY_ID_PATTERN.test(id) && name !== undefined
      ? [{ id, name }]
      : [];
  });
}

/**
 * Convierte un objeto track de Spotify en `SpotifyTrack`. Devuelve null si falta algo de lo
 * obligatorio: no se completa con suposiciones. La portada es opcional.
 * Los campos que Development Mode ya no entrega (popularity, available_markets) no se usan.
 */
export function parseSpotifyTrack(raw: unknown): SpotifyTrack | null {
  if (!isRecord(raw) || (raw.type !== undefined && raw.type !== 'track')) return null;
  const id = nonEmptyString(raw.id);
  const title = nonEmptyString(raw.name);
  const artists = parseArtists(raw.artists);
  const album = isRecord(raw.album) ? raw.album : undefined;
  const albumName = nonEmptyString(album?.name);
  const releaseDate = nonEmptyString(album?.release_date);
  const match = releaseDate === undefined ? null : RELEASE_DATE_PATTERN.exec(releaseDate);
  const primary = artists[0];

  if (
    id === undefined ||
    !SPOTIFY_ID_PATTERN.test(id) ||
    title === undefined ||
    primary === undefined ||
    albumName === undefined ||
    releaseDate === undefined ||
    match === null
  ) {
    return null;
  }

  const precision: ReleaseDatePrecision =
    match[3] !== undefined ? 'day' : match[2] !== undefined ? 'month' : 'year';
  const track: SpotifyTrack = {
    id,
    title,
    artist: primary.name,
    artistId: primary.id,
    artists,
    album: albumName,
    releaseYear: Number(match[1]),
    releaseDate,
    releaseDatePrecision: precision,
    url: `https://open.spotify.com/track/${id}`,
  };
  const albumType = nonEmptyString(album?.album_type);
  if (albumType !== undefined) track.albumType = albumType;

  // Spotify ordena las imágenes de mayor a menor: la primera https es la portada principal.
  const images = Array.isArray(album?.images) ? album.images : [];
  for (const image of images) {
    const url = isRecord(image) ? nonEmptyString(image.url) : undefined;
    if (url?.startsWith('https://')) {
      track.coverUrl = url;
      break;
    }
  }
  return track;
}

/** Quita comillas: delimitan el valor en los filtros de campo (`track:"..."`). */
const forFilter = (value: string) => value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();

export function createSpotifyClient({
  tokens,
  policy = DEFAULT_HTTP_POLICY,
  http = {},
  baseUrl = SPOTIFY_API_URL,
}: SpotifyClientOptions): SpotifyClient {
  const cache = new Map<string, SpotifyTrack>();

  const remember = (track: SpotifyTrack) => {
    cache.delete(track.id);
    cache.set(track.id, track);
    if (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value as string);
    }
  };

  const get = async (
    description: string,
    path: string,
    { budget }: SpotifyCallOptions = {},
  ): Promise<unknown> => {
    const authorization = `Bearer ${await tokens.getAccessToken(budget && { budget })}`;
    const { json } = await requestJson(
      description,
      `${baseUrl}${path}`,
      { headers: { authorization } },
      policy,
      budget === undefined ? http : { ...http, budget },
    );
    return json;
  };

  const search = async (q: string, options: SpotifyCallOptions): Promise<SpotifyTrack[]> => {
    const params = new URLSearchParams({ q, type: 'track', limit: String(SEARCH_LIMIT) });
    const json = await get('Spotify search', `/search?${params.toString()}`, options);
    const items = isRecord(json) && isRecord(json.tracks) ? json.tracks.items : undefined;
    if (!Array.isArray(items)) {
      throw new SpotifyMetadataError('a search response');
    }
    return items.flatMap((item) => {
      const track = parseSpotifyTrack(item);
      return track === null ? [] : [track];
    });
  };

  return {
    async getTrack(trackId, options = {}) {
      const cached = cache.get(trackId);
      if (cached) return cached;
      if (!SPOTIFY_ID_PATTERN.test(trackId)) {
        throw new SpotifyMetadataError('an invalid track id');
      }
      let json: unknown;
      try {
        json = await get('Spotify get track', `/tracks/${trackId}`, options);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          throw new SpotifyTrackNotFoundError(trackId);
        }
        throw error;
      }
      const track = parseSpotifyTrack(json);
      if (track === null || track.id !== trackId) {
        throw new SpotifyMetadataError(`track ${trackId}`);
      }
      remember(track);
      return track;
    },

    async searchTracks({ title, artist }: SpotifySearchQuery, options = {}) {
      const cleanTitle = forFilter(title);
      const cleanArtist = forFilter(artist);
      if (cleanTitle === '' || cleanArtist === '') return [];

      // Primero filtros por campo (más precisos); si no devuelven nada, texto libre.
      let found = await search(`track:"${cleanTitle}" artist:"${cleanArtist}"`, options);
      if (found.length === 0) {
        found = await search(`${cleanTitle} ${cleanArtist}`, options);
      }
      found.forEach(remember);
      return found;
    },
  };
}
