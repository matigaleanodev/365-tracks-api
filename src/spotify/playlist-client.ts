import {
  DEFAULT_HTTP_POLICY,
  requestJson,
  HttpError,
  type HttpDependencies,
  type HttpFailureKind,
  type HttpPolicy,
} from '../shared/resilient-fetch.ts';
import type { AccessTokenProvider } from './auth.ts';
import { SPOTIFY_API_URL, SPOTIFY_ID_PATTERN } from './client.ts';
import { SpotifyMetadataError } from './errors.ts';

/**
 * Se invoca después de obtener el token y antes de cada POST real (y de cada espera de un
 * reintento) con los ms que faltan para que empiece. Lanza para abortar sin escribir.
 */
export type WriteGuard = (startsInMs: number) => void;

/**
 * Una escritura pudo haber sido aplicada por Spotify aunque no lo sepamos (timeout, corte de red,
 * 5xx o respuesta de éxito ilegible). El mensaje no lleva títulos ni consultas.
 */
export class AmbiguousSpotifyWriteError extends Error {
  constructor(description: string, cause: unknown) {
    super(`${description} may have been applied: outcome unknown`, { cause });
    this.name = 'AmbiguousSpotifyWriteError';
  }
}

const AMBIGUOUS_KINDS = new Set<HttpFailureKind>([
  'timeout',
  'network',
  'server-error',
  'invalid-json',
]);

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
  create(input: CreatePlaylistInput, guard?: WriteGuard): Promise<PlaylistRef>;
  /**
   * Un elemento por cada ítem físico de la playlist, en orden: el ID del track, o `null` si el
   * ítem no es un track con ID (archivo local, episodio, borrado). Conserva las posiciones, que es
   * como Spotify interpreta `position`. Es la fuente de verdad para no duplicar.
   */
  listItems(playlistId: string): Promise<(string | null)[]>;
  /**
   * Agrega en el orden dado: al final, o desde `position` (índice base 0) para respetar el orden
   * cronológico al recuperar una canción faltante. No reintenta fallos ambiguos: la
   * sincronización relee la playlist real antes de volver a escribir. Un fallo ambiguo lanza
   * `AmbiguousSpotifyWriteError`; el `guard` se evalúa antes de cada bloque y de cada reintento.
   */
  addTracks(
    playlistId: string,
    trackIds: readonly string[],
    position?: number,
    guard?: WriteGuard,
  ): Promise<void>;
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

/**
 * Lee todas las páginas de un listado validándolas estrictamente antes de usarlas para decidir
 * una escritura: `items` arreglo, `total` entero no negativo, `next` string o null y cada entrada
 * un objeto. Al terminar, lo leído debe coincidir con `total`. Cualquier violación lanza
 * `SpotifyMetadataError`: una lista incompleta llevaría a duplicar o a crear de más.
 */
async function readAllPages(
  fetchPage: (offset: number) => Promise<unknown>,
  /** Valida el contenido de CADA entrada de la página antes de usar ninguna; lanza si es inválida. */
  validate: (entry: Record<string, unknown>) => void,
  onEntry: (entry: Record<string, unknown>) => boolean | void,
  what: string,
): Promise<void> {
  const malformed = () => new SpotifyMetadataError(`a malformed ${what} listing`);
  let read = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const json = await fetchPage(page * PAGE_SIZE);
    if (!isRecord(json) || !Array.isArray(json.items)) throw malformed();
    const { items, total, next } = json as { items: unknown[]; total: unknown; next: unknown };
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw malformed();
    if (next !== null && typeof next !== 'string') throw malformed();
    const entries = items.filter(isRecord);
    if (entries.length !== items.length) throw malformed();
    for (const entry of entries) validate(entry);
    read += entries.length;
    for (const entry of entries) {
      if (onEntry(entry) === true) return;
    }
    if (typeof next !== 'string') {
      if (read !== total) throw malformed();
      return;
    }
  }
  throw new SpotifyMetadataError(`a ${what} listing larger than the supported size`);
}

/**
 * Un ítem físico de `/items`: el ID del track, o `null` para null explícito, episodio o archivo
 * local (conservan su posición). Cualquier otra forma es malformada: no se decide nada con ella.
 */
function classifyItem(entry: Record<string, unknown>): string | null {
  const malformed = () => new SpotifyMetadataError('a malformed playlist item');
  // Se prefiere `item`; `track` es la forma antigua.
  const content = entry.item !== undefined ? entry.item : entry.track;
  if (content === null) return null;
  if (!isRecord(content)) throw malformed();
  if (content.type === 'episode') return null;
  if (content.type !== 'track') throw malformed();
  const isLocal = content.is_local;
  if (isLocal !== undefined && typeof isLocal !== 'boolean') throw malformed();
  if (isLocal === true) return null;
  if (typeof content.id !== 'string' || !SPOTIFY_ID_PATTERN.test(content.id)) throw malformed();
  return content.id;
}

/** Playlist de `/me/playlists`: nombre y dueño con ID, ambos strings. */
function assertPlaylistEntry(entry: Record<string, unknown>): void {
  if (
    typeof entry.name !== 'string' ||
    !isRecord(entry.owner) ||
    typeof entry.owner.id !== 'string'
  ) {
    throw new SpotifyMetadataError('a malformed playlist entry');
  }
}

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
    init: { method?: string; body?: unknown; policy?: HttpPolicy; guard?: WriteGuard } = {},
  ): Promise<unknown> => {
    // El token se obtiene primero: el guard mide el tiempo que queda justo antes de enviar.
    const authorization = `Bearer ${await tokens.getAccessToken()}`;
    try {
      const { json } = await requestJson(
        description,
        `${baseUrl}${path}`,
        {
          method: init.method ?? 'GET',
          headers: {
            authorization,
            ...(init.body !== undefined && { 'content-type': 'application/json' }),
          },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        },
        init.policy ?? policy,
        init.guard ? { ...http, beforeAttempt: init.guard } : http,
      );
      return json;
    } catch (error) {
      if (init.method === 'POST' && error instanceof HttpError && AMBIGUOUS_KINDS.has(error.kind)) {
        throw new AmbiguousSpotifyWriteError(description, error);
      }
      throw error;
    }
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
      let found: PlaylistRef | null = null;
      await readAllPages(
        (offset) =>
          call('Spotify list playlists', `/me/playlists?limit=${PAGE_SIZE}&offset=${offset}`),
        assertPlaylistEntry,
        (item) => {
          if (item.name === name && isRecord(item.owner) && item.owner.id === owner) {
            found = toRef(item);
            return true;
          }
        },
        'playlists',
      );
      return found;
    },

    async create({ name, description, isPublic }, guard) {
      const json = await call('Spotify create playlist', '/me/playlists', {
        method: 'POST',
        body: { name, description, public: isPublic },
        policy: writePolicy,
        ...(guard && { guard }),
      });
      try {
        return toRef(json);
      } catch (error) {
        // Un éxito sin ID válido: la playlist pudo haberse creado igual.
        throw new AmbiguousSpotifyWriteError('Spotify create playlist', error);
      }
    },

    async listItems(playlistId) {
      assertPlaylistId(playlistId);
      const ids: (string | null)[] = [];
      await readAllPages(
        // El endpoint vigente es `/items`; `/tracks` quedó obsoleto en 2026.
        (offset) =>
          call(
            'Spotify list playlist items',
            `/playlists/${playlistId}/items?limit=${PAGE_SIZE}&offset=${offset}`,
          ),
        classifyItem,
        (entry) => {
          ids.push(classifyItem(entry));
        },
        'playlist items',
      );
      return ids;
    },

    async addTracks(playlistId, trackIds, position, guard) {
      assertPlaylistId(playlistId);
      for (let start = 0; start < trackIds.length; start += MAX_ITEMS_PER_ADD) {
        const uris = trackIds
          .slice(start, start + MAX_ITEMS_PER_ADD)
          .map((id) => `spotify:track:${id}`);
        await call('Spotify add playlist items', `/playlists/${playlistId}/items`, {
          method: 'POST',
          body: position === undefined ? { uris } : { uris, position: position + start },
          policy: writePolicy,
          ...(guard && { guard }),
        });
      }
    },
  };
}
