import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParameterStore } from '../../src/config/parameters.ts';
import { createPlaylistDependencies } from '../../src/jobs/dependencies.ts';
import type { PlaylistStateRepository } from '../../src/playlist/state.ts';
import { syncPlaylists } from '../../src/playlist/sync.ts';
import type { HttpPolicy } from '../../src/shared/resilient-fetch.ts';
import { createRefreshTokenProvider } from '../../src/spotify/auth.ts';
import { createSpotifyPlaylistClient } from '../../src/spotify/playlist-client.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { preparedTrack } from '../support/music.ts';

const policy: HttpPolicy = {
  timeoutMs: 1000,
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 1,
  maxRetryAfterMs: 1,
};

const PLAYLIST_ID = `plist${'0'.repeat(16)}1`;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const forbidden = (what: string) => () => {
  throw new Error(`write not allowed in dry-run: ${what}`);
};

/** Estado que falla ante cualquier escritura o candado; solo lee. */
function readOnlyState(): PlaylistStateRepository {
  return {
    getPlaylist: () =>
      Promise.resolve({
        year: 2027,
        playlistId: PLAYLIST_ID,
        url: 'https://open.spotify.com/playlist/x',
        createdAt: '2027-01-01T00:00:00.000Z',
      }),
    listSynced: () => Promise.resolve([]),
    savePlaylist: forbidden('savePlaylist'),
    markSynced: forbidden('markSynced'),
    acquireLock: forbidden('acquireLock'),
    releaseLock: forbidden('releaseLock'),
  };
}

/** Fake de Spotify: solo GET de items y el endpoint de token; cualquier otra cosa falla. */
function spotifyFetch(tokenBodies: Record<string, unknown>[]) {
  const queue = [...tokenBodies];
  return vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target === TOKEN_URL) {
      const body = queue.shift();
      return Promise.resolve(body ? json(body) : json({}, 500));
    }
    if (method === 'GET' && target.includes(`/playlists/${PLAYLIST_ID}/items`)) {
      return Promise.resolve(json({ items: [], total: 0, next: null }));
    }
    throw new Error(`unexpected request in dry-run: ${method} ${target}`);
  });
}

const tracks = [preparedTrack('2027-01-01', 1), preparedTrack('2027-01-02', 2)];
const NOW = new Date('2027-01-03T12:30:00Z');

describe('dry-run de punta a punta', () => {
  it('con rotación: la única escritura es guardar el refresh token rotado', async () => {
    const put = vi.fn((_name: string, _value: string) => Promise.resolve());
    const fetchMock = spotifyFetch([
      { access_token: 'A', expires_in: 3600, refresh_token: 'NEW-REFRESH' },
    ]);
    const http = { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() };
    const tokens = createRefreshTokenProvider({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'OLD-REFRESH',
      onRefreshTokenRotated: (value) => put('/tracks365/spotify/refresh-token', value),
      policy,
      http,
    });

    const report = await syncPlaylists(
      {
        tracks: new InMemoryTrackRepository(tracks),
        state: readOnlyState(),
        playlists: createSpotifyPlaylistClient({ tokens, policy, http }),
        now: () => NOW,
      },
      { dryRun: true },
    );

    expect(report.dryRun).toBe(true);
    expect(report.years[0]?.added).toEqual(['2027-01-01', '2027-01-02']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/tracks365/spotify/refresh-token', 'NEW-REFRESH');
    const methods = fetchMock.mock.calls.map(
      ([url, init]) => `${init?.method ?? 'GET'} ${String(url).split('?')[0]}`,
    );
    expect(methods.filter((m) => m.startsWith('POST') && !m.endsWith(TOKEN_URL))).toEqual([]);
  });

  it('sin rotación no se escribe nada en ningún lado', async () => {
    const put = vi.fn(() => Promise.resolve());
    const fetchMock = spotifyFetch([{ access_token: 'A', expires_in: 3600 }]);
    const http = { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() };
    const tokens = createRefreshTokenProvider({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'OLD-REFRESH',
      onRefreshTokenRotated: put,
      policy,
      http,
    });
    await syncPlaylists(
      {
        tracks: new InMemoryTrackRepository(tracks),
        state: readOnlyState(),
        playlists: createSpotifyPlaylistClient({ tokens, policy, http }),
        now: () => NOW,
      },
      { dryRun: true },
    );
    expect(put).not.toHaveBeenCalled();
  });

  it('si la rotación no se puede guardar, aborta antes de leer la playlist', async () => {
    const fetchMock = spotifyFetch([
      { access_token: 'A', expires_in: 3600, refresh_token: 'NEW-REFRESH' },
    ]);
    const http = { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() };
    const tokens = createRefreshTokenProvider({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'OLD-REFRESH',
      onRefreshTokenRotated: () => Promise.reject(new Error('AccessDenied')),
      policy,
      http,
    });
    await expect(
      syncPlaylists(
        {
          tracks: new InMemoryTrackRepository(tracks),
          state: readOnlyState(),
          playlists: createSpotifyPlaylistClient({ tokens, policy, http }),
          now: () => NOW,
        },
        { dryRun: true },
      ),
    ).rejects.toMatchObject({ failure: 'rotation_not_persisted' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // solo el endpoint de token
  });
});

describe('createPlaylistDependencies', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = {
    SSM_PARAMETER_PREFIX: '/tracks365',
    TRACKS_TABLE_NAME: 'tracks-table',
    AWS_REGION: 'us-east-1',
  };

  function fakeStore() {
    const put = vi.fn((_name: string, _value: string) => Promise.resolve());
    const store: ParameterStore = {
      getMany: (names) =>
        Promise.resolve(
          new Map(
            names.map((name) => [
              name,
              name.endsWith('refresh-token') ? 'OLD-REFRESH' : `value-of-${name}`,
            ]),
          ),
        ),
      put,
    };
    return { store, put };
  }

  it('guarda el token rotado en el parámetro del refresh token, solo ante rotación', async () => {
    const { store, put } = fakeStore();
    const fetchMock = spotifyFetch([
      { access_token: 'A', expires_in: 1, refresh_token: 'NEW-REFRESH' },
      { access_token: 'B', expires_in: 3600 },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const deps = await createPlaylistDependencies(env, store);
    expect(put).not.toHaveBeenCalled();

    await deps.playlists.listItems(PLAYLIST_ID); // renueva: Spotify rota
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/tracks365/spotify/refresh-token', 'NEW-REFRESH');

    await deps.playlists.listItems(PLAYLIST_ID); // renueva otra vez, sin rotación
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('sin rotación no invoca put', async () => {
    const { store, put } = fakeStore();
    vi.stubGlobal('fetch', spotifyFetch([{ access_token: 'A', expires_in: 3600 }]));
    const deps = await createPlaylistDependencies(env, store);
    await deps.playlists.listItems(PLAYLIST_ID);
    expect(put).not.toHaveBeenCalled();
  });
});
