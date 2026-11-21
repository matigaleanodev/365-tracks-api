import {
  DEFAULT_HTTP_POLICY,
  requestJson,
  type HttpDependencies,
  type HttpPolicy,
} from '../shared/resilient-fetch.ts';
import type { AccessTokenProvider } from './auth.ts';
import { SPOTIFY_API_URL, SPOTIFY_ID_PATTERN } from './client.ts';
import { SpotifyMetadataError } from './errors.ts';

export interface PlaylistRef {
  id: string;
  url: string;
}

export interface CreatePlaylistInput {
  name: string;
  description: string;
  isPublic: boolean;
}

/** Operaciones de la cuenta propietaria. Requiere un token de usuario (refresh token). */
export interface SpotifyPlaylistClient {
  /** Busca entre las playlists de la cuenta propietaria; permite reutilizar en vez de duplicar. */
  findOwnedByName(name: string): Promise<PlaylistRef | null>;
  create(input: CreatePlaylistInput): Promise<PlaylistRef>;
  /** IDs de las canciones presentes, en orden. Es la fuente de verdad para no duplicar. */
  listTrackIds(playlistId: string): Promise<string[]>;
  /** Agrega al final, en el orden dado. No reintenta fallos ambiguos: ver `reconcile`. */
  addTracks(playlistId: string, trackIds: readonly string[]): Promise<void>;
}

export interface SpotifyPlaylistClientOptions {
  tokens: AccessTokenProvider;
  policy?: HttpPolicy;
  http?: HttpDependencies;
  baseUrl?: string;
}

const PAGE_SIZE = 50;
/** Tope de páginas (50 × 40 = 2000 ítems): evita un bucle ante respuestas defectuosas. */
const MAX_PAGES = 40;
const MAX_ITEMS_PER_ADD = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertPlaylistId(id: string): void {
  if (!SPOTIFY_ID_PATTERN.test(id)) {
    throw new SpotifyMetadataError('an invalid playlist id');
  }
}

function toRef(json: unknown): PlaylistRef {
  const id = isRecord(json) && typeof json.id === 'string' ? json.id : '';
  if (!SPOTIFY_ID_PATTERN.test(id)) {
    throw new SpotifyMetadataError('a playlist');
  }
  return { id, url: `https://open.spotify.com/playlist/${id}` };
}

export function createSpotifyPlaylistClient({
  tokens,
  policy = DEFAULT_HTTP_POLICY,
  http = {},
  baseUrl = SPOTIFY_API_URL,
}: SpotifyPlaylistClientOptions): SpotifyPlaylistClient {
  // Escribir no es idempotente: un timeout puede haber creado o agregado igual.
  const writePolicy: HttpPolicy = { ...policy, retryAmbiguousFailures: false };
  let ownerId: string | undefined;

  const call = async (
    description: string,
    path: string,
    init: { method?: string; body?: unknown; policy?: HttpPolicy } = {},
  ): Promise<unknown> => {
    const { json } = await requestJson(
      description,
      `${baseUrl}${path}`,
      {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${await tokens.getAccessToken()}`,
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      },
      init.policy ?? policy,
      http,
    );
    return json;
  };

  const getOwnerId = async (): Promise<string> => {
    if (ownerId === undefined) {
      const json = await call('Spotify get current user', '/me');
      const id = isRecord(json) && typeof json.id === 'string' ? json.id : '';
      if (id === '') throw new SpotifyMetadataError('the current user');
      ownerId = id;
    }
    return ownerId;
  };

  return {
    async findOwnedByName(name) {
      const owner = await getOwnerId();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const json = await call(
          'Spotify list playlists',
          `/me/playlists?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        );
        const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
        for (const item of items) {
          if (
            isRecord(item) &&
            item.name === name &&
            isRecord(item.owner) &&
            item.owner.id === owner
          ) {
            return toRef(item);
          }
        }
        if (items.length < PAGE_SIZE) break;
      }
      return null;
    },

    async create({ name, description, isPublic }) {
      const json = await call('Spotify create playlist', '/me/playlists', {
        method: 'POST',
        body: { name, description, public: isPublic },
        policy: writePolicy,
      });
      return toRef(json);
    },

    async listTrackIds(playlistId) {
      assertPlaylistId(playlistId);
      const ids: string[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // El endpoint vigente es `/items`; `/tracks` quedó obsoleto en 2026.
        const json = await call(
          'Spotify list playlist items',
          `/playlists/${playlistId}/items?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
        );
        const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
        for (const entry of items) {
          // La respuesta nueva usa `item`; se acepta `track` por compatibilidad.
          const content = isRecord(entry) ? (entry.item ?? entry.track) : undefined;
          if (isRecord(content) && content.type === 'track' && typeof content.id === 'string') {
            ids.push(content.id);
          }
        }
        if (items.length < PAGE_SIZE) return ids;
      }
      throw new SpotifyMetadataError('a playlist larger than the supported size');
    },

    async addTracks(playlistId, trackIds) {
      assertPlaylistId(playlistId);
      for (let start = 0; start < trackIds.length; start += MAX_ITEMS_PER_ADD) {
        const uris = trackIds
          .slice(start, start + MAX_ITEMS_PER_ADD)
          .map((id) => `spotify:track:${id}`);
        await call('Spotify add playlist items', `/playlists/${playlistId}/items`, {
          method: 'POST',
          body: { uris },
          policy: writePolicy,
        });
      }
    },
  };
}
