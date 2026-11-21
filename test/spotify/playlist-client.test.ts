import { describe, expect, it, vi } from 'vitest';
import type { HttpPolicy } from '../../src/shared/resilient-fetch.ts';
import { createSpotifyPlaylistClient } from '../../src/spotify/playlist-client.ts';
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
          { id: PLAYLIST_ID, name: '365 Tracks 2027', owner: { id: 'someone-else' } },
          { id: 'pl00000000000000000002', name: '365 Tracks 2027', owner: { id: 'owner' } },
        ],
      });
    });
    await expect(client.findOwnedByName('365 Tracks 2027')).resolves.toEqual({
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
      return json({ items: url.searchParams.get('offset') === '0' ? page : [] });
    });
    await expect(client.findOwnedByName('365 Tracks 2027')).resolves.toBeNull();
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

  it('lista los IDs desde /items (no /tracks), aceptando item o track', async () => {
    const { client, fetchMock } = setup(() =>
      json({
        items: [
          { item: { type: 'track', id: spotifyId(1) } },
          { track: { type: 'track', id: spotifyId(2) } },
          { item: { type: 'episode', id: 'ep' } },
          { item: null },
        ],
      }),
    );
    await expect(client.listTrackIds(PLAYLIST_ID)).resolves.toEqual([spotifyId(1), spotifyId(2)]);
    expect(calls(fetchMock)[0]?.url.pathname).toBe(`/v1/playlists/${PLAYLIST_ID}/items`);
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

  it('una escritura con resultado ambiguo (5xx) NO se reintenta', async () => {
    const { client, fetchMock } = setup(() => json({}, 503));
    await expect(client.addTracks(PLAYLIST_ID, [spotifyId(1)])).rejects.toMatchObject({
      kind: 'server-error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una lectura sí se reintenta ante un 5xx', async () => {
    let attempts = 0;
    const { client } = setup(() => {
      attempts += 1;
      return attempts === 1 ? json({}, 503) : json({ items: [] });
    });
    await expect(client.listTrackIds(PLAYLIST_ID)).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it('rechaza IDs de playlist inválidos antes de llamar', async () => {
    const { client, fetchMock } = setup(() => json({}));
    await expect(client.listTrackIds('../x')).rejects.toThrow(/invalid playlist id/);
    await expect(client.addTracks('../x', [spotifyId(1)])).rejects.toThrow(/invalid playlist id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
