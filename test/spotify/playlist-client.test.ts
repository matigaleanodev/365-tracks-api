import { describe, expect, it, vi } from 'vitest';
import type { HttpPolicy } from '../../src/shared/resilient-fetch.ts';
import {
  AmbiguousSpotifyWriteError,
  createSpotifyPlaylistClient,
} from '../../src/spotify/playlist-client.ts';
import { SpotifyMetadataError } from '../../src/spotify/errors.ts';
import { spotifyId } from '../support/music.ts';

const PLAYLIST_ID = 'pl00000000000000000001';
const policy: HttpPolicy = {
  timeoutMs: 1000,
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 1,
  maxRetryAfterMs: 5,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(respond: (url: URL, init: RequestInit) => Response | Error) {
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    const result = respond(new URL(url), init);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const client = createSpotifyPlaylistClient({
    tokens: { getAccessToken: () => Promise.resolve('owner-token') },
    policy,
    http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
  });
  return { client, fetchMock };
}

const calls = (mock: ReturnType<typeof vi.fn>) =>
  mock.mock.calls.map((call) => {
    const [url, init] = call as unknown as [string, RequestInit];
    return { url: new URL(url), method: init.method ?? 'GET', body: init.body as string };
  });

describe('createSpotifyPlaylistClient', () => {
  it('busca entre las playlists de la cuenta propietaria (nombre y dueño)', async () => {
    const { client } = setup((url) => {
      if (url.pathname === '/v1/me') return json({ id: 'owner' });
      return json({
        items: [
          { id: PLAYLIST_ID, name: 'Daywave 2027', owner: { id: 'someone-else' } },
          { id: 'pl00000000000000000002', name: 'Daywave 2027', owner: { id: 'owner' } },
        ],
        total: 2,
        next: null,
      });
    });
    await expect(client.findOwnedByName('Daywave 2027')).resolves.toEqual({
      id: 'pl00000000000000000002',
      url: 'https://open.spotify.com/playlist/pl00000000000000000002',
    });
  });

  it('pagina de a 50 y devuelve null si no existe', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `pl${String(i).padStart(20, '0')}`,
      name: `Other ${i}`,
      owner: { id: 'owner' },
    }));
    const { client, fetchMock } = setup((url) => {
      if (url.pathname === '/v1/me') return json({ id: 'owner' });
      const first = url.searchParams.get('offset') === '0';
      return json({
        items: first ? page : [],
        total: 50,
        next: first ? 'https://api/next' : null,
        limit: 50,
        offset: first ? 0 : 50,
      });
    });
    await expect(client.findOwnedByName('Daywave 2027')).resolves.toBeNull();
    expect(calls(fetchMock).filter((c) => c.url.pathname === '/v1/me/playlists')).toHaveLength(2);
  });

  it('crea la playlist pública con POST /me/playlists', async () => {
    const { client, fetchMock } = setup(() => json({ id: PLAYLIST_ID }, 201));
    const ref = await client.create({ name: 'N', description: 'D', isPublic: true });
    expect(ref.id).toBe(PLAYLIST_ID);
    const [call] = calls(fetchMock);
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/v1/me/playlists');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ name: 'N', description: 'D', public: true });
  });

  it('lista un elemento por ítem físico (null si no es un track) desde /items, aceptando item o track', async () => {
    const { client, fetchMock } = setup(() =>
      json({
        items: [
          { item: { type: 'track', id: spotifyId(1) } },
          { track: { type: 'track', id: spotifyId(2) } },
          { item: { type: 'episode', id: 'ep' } },
          { item: null },
        ],
        total: 4,
        next: null,
      }),
    );
    await expect(client.listItems(PLAYLIST_ID)).resolves.toEqual([
      spotifyId(1),
      spotifyId(2),
      null,
      null,
    ]);
    expect(calls(fetchMock)[0]?.url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}/items`);
  });

  it('clasifica null explícito, episodio y archivo local como ranuras null, y prefiere item sobre track', async () => {
    const { client } = setup(() =>
      json({
        items: [
          { item: null },
          { item: { type: 'episode', id: 'ep' } },
          { item: { type: 'track', is_local: true, id: null } },
          { item: { type: 'track', id: spotifyId(1) }, track: { type: 'track', id: spotifyId(9) } },
        ],
        total: 4,
        next: null,
      }),
    );
    await expect(client.listItems(PLAYLIST_ID)).resolves.toEqual([null, null, null, spotifyId(1)]);
  });

  it.each([
    ['{}', {}],
    ['track sin id', { item: { type: 'track' } }],
    ['track con id inválido', { item: { type: 'track', id: 'x' } }],
    ['tipo desconocido', { item: { type: 'show', id: spotifyId(1) } }],
    ['is_local no booleano', { item: { type: 'track', id: spotifyId(1), is_local: 1 } }],
  ])('listItems rechaza una entrada %s', async (_name, entry) => {
    const { client } = setup(() => json({ items: [entry], total: 1, next: null }));
    await expect(client.listItems(PLAYLIST_ID)).rejects.toBeInstanceOf(SpotifyMetadataError);
  });

  it.each([
    ['sin name', { id: PLAYLIST_ID, owner: { id: 'owner' } }],
    ['sin owner', { id: PLAYLIST_ID, name: 'n' }],
    ['owner sin id', { id: PLAYLIST_ID, name: 'n', owner: {} }],
  ])('findOwnedByName rechaza una entrada %s aunque no sea la buscada', async (_name, entry) => {
    const { client } = setup((url) =>
      url.pathname === '/v1/me'
        ? json({ id: 'owner' })
        : json({ items: [entry], total: 1, next: null }),
    );
    await expect(client.findOwnedByName('otra')).rejects.toBeInstanceOf(SpotifyMetadataError);
  });

  it('agrega por /items en el orden dado, en bloques de 100', async () => {
    const { client, fetchMock } = setup(() => json({ snapshot_id: 's' }, 201));
    const ids = Array.from({ length: 150 }, (_, i) => spotifyId(i));
    await client.addTracks(PLAYLIST_ID, ids);

    const writes = calls(fetchMock);
    expect(writes).toHaveLength(2);
    expect(writes[0]?.url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}/items`);
    const first = JSON.parse(writes[0]?.body ?? '{}') as { uris: string[] };
    const second = JSON.parse(writes[1]?.body ?? '{}') as { uris: string[] };
    expect(first.uris).toHaveLength(100);
    expect(first.uris[0]).toBe(`spotify:track:${spotifyId(0)}`);
    expect(second.uris).toHaveLength(50);
    expect(second.uris[0]).toBe(`spotify:track:${spotifyId(100)}`);
  });

  it('con position inserta en ese índice y lo avanza entre bloques', async () => {
    const { client, fetchMock } = setup(() => json({ snapshot_id: 's' }, 201));
    await client.addTracks(
      PLAYLIST_ID,
      Array.from({ length: 150 }, (_, i) => spotifyId(i)),
      7,
    );
    const bodies = calls(fetchMock).map((c) => JSON.parse(c.body ?? '{}') as { position?: number });
    expect(bodies.map((b) => b.position)).toEqual([7, 107]);
  });

  it('sin position agrega al final (no envía el campo)', async () => {
    const { client, fetchMock } = setup(() => json({ snapshot_id: 's' }, 201));
    await client.addTracks(PLAYLIST_ID, [spotifyId(1)]);
    expect(JSON.parse(calls(fetchMock)[0]?.body ?? '{}')).not.toHaveProperty('position');
  });

  it('una página corta con next no nulo sigue paginando', async () => {
    const entry = (n: number) => ({ item: { type: 'track', id: spotifyId(n) } });
    const { client, fetchMock } = setup((url) => {
      const offset = url.searchParams.get('offset');
      if (offset === '0') {
        return json({ items: [entry(1), entry(2)], next: 'https://api/next', total: 3 });
      }
      return json({ items: [entry(3)], next: null, total: 3 });
    });
    await expect(client.listItems(PLAYLIST_ID)).resolves.toEqual([
      spotifyId(1),
      spotifyId(2),
      spotifyId(3),
    ]);
    expect(calls(fetchMock).map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '50']);
  });

  it('si el total no coincide con lo leído lanza en vez de devolver una lista incompleta', async () => {
    const { client } = setup(() =>
      json({ items: [{ item: { type: 'track', id: spotifyId(1) } }], next: null, total: 2 }),
    );
    await expect(client.listItems(PLAYLIST_ID)).rejects.toBeInstanceOf(SpotifyMetadataError);
  });

  it('una escritura con resultado ambiguo (5xx) NO se reintenta', async () => {
    const { client, fetchMock } = setup(() => json({}, 503));
    await expect(client.addTracks(PLAYLIST_ID, [spotifyId(1)])).rejects.toMatchObject({
      name: 'AmbiguousSpotifyWriteError',
      cause: { kind: 'server-error' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('timeout, corte de red y éxito ilegible en un POST son ambiguos; un 4xx no', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const withTimeout = setup(() => timeout);
    await expect(withTimeout.client.addTracks(PLAYLIST_ID, [spotifyId(1)])).rejects.toBeInstanceOf(
      AmbiguousSpotifyWriteError,
    );
    const network = setup(() => new TypeError('fetch failed'));
    await expect(
      network.client.create({ name: 'n', description: 'd', isPublic: true }),
    ).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);
    const garbled = setup(() => new Response('<html>', { status: 200 }));
    await expect(garbled.client.addTracks(PLAYLIST_ID, [spotifyId(1)])).rejects.toBeInstanceOf(
      AmbiguousSpotifyWriteError,
    );
    // Creada pero sin un ID válido: pudo haberse creado igual.
    const noId = setup(() => json({}, 201));
    await expect(
      noId.client.create({ name: 'n', description: 'd', isPublic: true }),
    ).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);
    const rejected = setup(() => json({}, 403));
    await expect(rejected.client.addTracks(PLAYLIST_ID, [spotifyId(1)])).rejects.toMatchObject({
      kind: 'client-error',
    });
  });

  it('el guard corre después de obtener el token y antes de cada POST; si lanza no se envía', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(() => {
      order.push('fetch');
      return Promise.resolve(json({ snapshot_id: 's' }, 201));
    });
    const client = createSpotifyPlaylistClient({
      tokens: {
        getAccessToken: () => {
          order.push('token');
          return Promise.resolve('owner-token');
        },
      },
      policy,
      http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
    });
    const ids = Array.from({ length: 150 }, (_, i) => spotifyId(i));
    await client.addTracks(PLAYLIST_ID, ids, undefined, (startsInMs) => {
      order.push(`guard:${startsInMs}`);
    });
    expect(order).toEqual(['token', 'guard:0', 'fetch', 'token', 'guard:0', 'fetch']);

    fetchMock.mockClear();
    const stop = new Error('budget');
    await expect(
      client.addTracks(PLAYLIST_ID, ids, undefined, () => {
        throw stop;
      }),
    ).rejects.toBe(stop);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una lectura sí se reintenta ante un 5xx', async () => {
    let attempts = 0;
    const { client } = setup(() => {
      attempts += 1;
      return attempts === 1 ? json({}, 503) : json({ items: [], total: 0, next: null });
    });
    await expect(client.listItems(PLAYLIST_ID)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('rechaza IDs de playlist inválidos antes de llamar', async () => {
    const { client, fetchMock } = setup(() => json({}));
    await expect(client.listItems('../x')).rejects.toThrow(/invalid playlist id/);
    await expect(client.addTracks('../x', [spotifyId(1)])).rejects.toThrow(/invalid playlist id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
