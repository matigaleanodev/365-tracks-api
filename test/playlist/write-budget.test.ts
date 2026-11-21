import { describe, expect, it, vi } from 'vitest';
import { createSyncPlaylistHandler } from '../../src/jobs/sync-playlist-handler.ts';
import { InMemoryPlaylistState } from '../../src/playlist/state.ts';
import {
  LEASE_SAFETY_MS,
  LOCK_TTL_MS,
  syncPlaylists,
  WriteBudgetExhaustedError,
  type SyncDependencies,
} from '../../src/playlist/sync.ts';
import { DEFAULT_HTTP_POLICY, HttpError } from '../../src/shared/resilient-fetch.ts';
import { SpotifyMetadataError } from '../../src/spotify/errors.ts';
import {
  AmbiguousSpotifyWriteError,
  createSpotifyPlaylistClient,
} from '../../src/spotify/playlist-client.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { preparedTrack, spotifyId } from '../support/music.ts';

const PLAYLIST_ID = 'pl00000000000000000001';
const NOW = '2027-01-04T12:30:00Z'; // última elegible: 2027-01-03
const T0 = Date.parse(NOW);
const SECOND = 1000;

interface Req {
  url: string;
  method: string;
  path: string;
  body: { uris?: string[]; position?: number } | undefined;
}

/**
 * Spotify simulado con reloj falso: la latencia de cada petición avanza el reloj, y `sleep`
 * también. Nada usa timers reales. `override` permite fallar o demorar una petición concreta.
 */
function setup(options: { days?: number; existingPlaylist?: boolean } = {}) {
  const { days = 3, existingPlaylist = true } = options;
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const sleep = vi.fn((ms: number) => {
    clock.ms += ms;
    return Promise.resolve();
  });

  const playlist: (string | Record<string, unknown>)[] = [];
  const requests: Req[] = [];
  const pending: (() => void)[] = [];
  let playlistExists = existingPlaylist;
  const latency: (req: Req) => number = () => 0;
  const hooks = {
    latency,
    override: undefined as undefined | ((req: Req) => Response | Error | undefined),
  };

  const apply = (req: Req) => {
    if (req.method === 'POST' && req.path === '/me/playlists') {
      playlistExists = true;
      return new Response(JSON.stringify({ id: PLAYLIST_ID }), { status: 201 });
    }
    if (req.method === 'POST') {
      const ids = (req.body?.uris ?? []).map((uri) => uri.replace('spotify:track:', ''));
      playlist.splice(req.body?.position ?? playlist.length, 0, ...ids);
      return new Response(JSON.stringify({ snapshot_id: 's' }), { status: 201 });
    }
    if (req.path === '/me') return new Response(JSON.stringify({ id: 'owner' }));
    if (req.path === '/me/playlists') {
      const items = playlistExists
        ? [{ id: PLAYLIST_ID, name: '365 Tracks 2027', owner: { id: 'owner' } }]
        : [];
      return new Response(JSON.stringify({ items, total: items.length, next: null }));
    }
    const offset = Number(new URL(req.url).searchParams.get('offset') ?? 0);
    const items = playlist
      .slice(offset, offset + 50)
      .map((id) => (typeof id === 'string' ? { item: { type: 'track', id } } : id));
    const next = offset + 50 < playlist.length ? 'https://api/next' : null;
    return new Response(JSON.stringify({ items, total: playlist.length, next }));
  };

  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const path = pathname.replace('/v1', '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Req['body']) : undefined;
    const req: Req = { url, method: init.method ?? 'GET', path, body };
    requests.push(req);
    clock.ms += hooks.latency(req);
    const forced = hooks.override?.(req);
    if (forced instanceof Error) return Promise.reject(forced);
    if (forced) return Promise.resolve(forced);
    return Promise.resolve(apply(req));
  });

  const playlists = createSpotifyPlaylistClient({
    tokens: { getAccessToken: () => Promise.resolve('owner-token') },
    policy: DEFAULT_HTTP_POLICY,
    http: { fetch: fetchMock as unknown as typeof fetch, sleep, random: () => 0.5 },
  });

  const start = new Date('2027-01-01T00:00:00Z');
  const tracks = Array.from({ length: days }, (_, i) => {
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return preparedTrack(date, i + 1);
  });
  const state = new InMemoryPlaylistState();
  const deps: SyncDependencies = {
    tracks: new InMemoryTrackRepository(tracks),
    state,
    playlists,
    now,
  };
  const posts = (path?: string) =>
    requests.filter((r) => r.method === 'POST' && (path === undefined || r.path === path));
  const register = () =>
    state.savePlaylist({
      year: 2027,
      playlistId: PLAYLIST_ID,
      url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
      createdAt: NOW,
    });
  const lockHeld = async () => !(await state.acquireLock(2027, 'otro', clock.ms, LOCK_TTL_MS));
  return {
    clock,
    sleep,
    playlist,
    requests,
    pending,
    hooks,
    deps,
    state,
    posts,
    register,
    lockHeld,
    apply,
    fetchMock,
  };
}

const rateLimited = () => new Response('{}', { status: 429, headers: { 'retry-after': '15' } });

describe('presupuesto de escritura (candado y deadline de la Lambda)', () => {
  it('el margen siempre supera el timeout de una escritura en vuelo', () => {
    expect(LEASE_SAFETY_MS).toBeGreaterThan(DEFAULT_HTTP_POLICY.timeoutMs);
  });

  it('un POST en el segundo 269 que recibe 429 con Retry-After 15 aborta sin dormir ni reenviar', async () => {
    const ctx = setup();
    await ctx.register();
    // La lectura de la playlist termina en el segundo 269 de un candado de 300 s.
    ctx.hooks.latency = (req) =>
      req.path.endsWith('/items') && req.method === 'GET' ? 269 * SECOND : 0;
    ctx.hooks.override = (req) => (req.method === 'POST' ? rateLimited() : undefined);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(WriteBudgetExhaustedError);

    expect(ctx.posts()).toHaveLength(1);
    expect(ctx.sleep).not.toHaveBeenCalled();
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    expect(await ctx.lockHeld()).toBe(false); // se liberó
  });

  it('si la búsqueda de la playlist termina con el candado vencido no se envía el POST de creación', async () => {
    const ctx = setup({ existingPlaylist: false });
    ctx.hooks.latency = (req) => (req.path === '/me/playlists' ? LOCK_TTL_MS + SECOND : 0);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(WriteBudgetExhaustedError);

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    expect(await ctx.lockHeld()).toBe(false);
  });

  it('si el primer bloque de 100 deja poco margen no se envía el segundo', async () => {
    const ctx = setup({ days: 105 });
    await ctx.register();
    // El primer bloque empieza en el 262 (quedan 38 s) y tarda 9 s (< timeout): termina en el 271.
    ctx.hooks.latency = (req) => {
      if (req.method === 'GET' && req.path.endsWith('/items')) return 262 * SECOND;
      return req.method === 'POST' ? 9 * SECOND : 0;
    };
    ctx.deps.now = () => new Date(ctx.clock.ms + 100 * 86_400_000); // todas elegibles

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(WriteBudgetExhaustedError);

    expect(ctx.posts()).toHaveLength(1);
    expect(ctx.playlist).toHaveLength(100);
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    expect(await ctx.lockHeld()).toBe(false);
  });

  it('el deadline de la Lambda más ajustado que el candado también corta las escrituras', async () => {
    const ctx = setup();
    await ctx.register();
    // Con solo el candado (300 s) escribiría; con deadline a 60 s ya no queda margen en el 35.
    ctx.hooks.latency = (req) =>
      req.path.endsWith('/items') && req.method === 'GET' ? 35 * SECOND : 0;

    await expect(syncPlaylists(ctx.deps, { deadlineMs: T0 + 60 * SECOND })).rejects.toBeInstanceOf(
      WriteBudgetExhaustedError,
    );

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });

  it('el handler traduce el tiempo restante del contexto de Lambda en deadlineMs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ctx = setup();
    await ctx.register();
    ctx.hooks.latency = (req) =>
      req.path.endsWith('/items') && req.method === 'GET' ? 35 * SECOND : 0;
    const handler = createSyncPlaylistHandler(ctx.deps);

    await expect(
      handler(undefined, { getRemainingTimeInMillis: () => 60 * SECOND }),
    ).rejects.toBeInstanceOf(WriteBudgetExhaustedError);
    expect(ctx.posts()).toHaveLength(0);

    // Sin contexto (scripts, tests) solo rige el candado.
    ctx.clock.ms = T0;
    await handler();
    expect(ctx.playlist).toHaveLength(3);
  });
});

describe('lectura incompleta de la playlist', () => {
  it('si el total no coincide con lo leído aborta sin escribir y libera el candado', async () => {
    const ctx = setup();
    await ctx.register();
    ctx.hooks.override = (req) =>
      req.method === 'GET' && req.path.endsWith('/items')
        ? new Response(JSON.stringify({ items: [], next: null, total: 5 }))
        : undefined;

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });
});

describe('lecturas validadas antes de mutar', () => {
  const only = (ctx: ReturnType<typeof setup>, match: (req: Req) => boolean, body: unknown) => {
    ctx.hooks.override = (req) => (match(req) ? new Response(JSON.stringify(body)) : undefined);
  };
  const isItems = (req: Req) => req.method === 'GET' && req.path.endsWith('/items');
  const isPlaylists = (req: Req) => req.method === 'GET' && req.path === '/me/playlists';

  it.each([
    ['sin items ni total ({})', {}],
    ['con items pero sin total', { items: [], next: null }],
    ['sin next', { items: [], total: 0 }],
    ['con total negativo', { items: [], total: -1, next: null }],
    ['con entradas que no son objetos', { items: ['x'], total: 1, next: null }],
    ['página corta con next null y menos que total', { items: [], total: 3, next: null }],
  ])('/items %s: aborta antes de agregar y libera el candado', async (_name, body) => {
    const ctx = setup();
    await ctx.register();
    only(ctx, isItems, body);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });

  it.each([
    ['{}', {}],
    ['sin next', { items: [], total: 0 }],
    ['sin total', { items: [], next: null }],
    ['con total distinto de lo leído', { items: [], total: 2, next: null }],
  ])('/me/playlists %s: no crea la playlist', async (_name, body) => {
    const ctx = setup({ existingPlaylist: false });
    only(ctx, isPlaylists, body);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });
});

describe('contenido de las entradas validado antes de decidir', () => {
  const items = (entries: unknown[]) => ({ items: entries, total: entries.length, next: null });
  const TRACK = { type: 'track', id: spotifyId(1) };

  it.each([
    ['entrada vacía {}', [{}]],
    ['track sin id', [{ item: { type: 'track' } }]],
    ['track con id inválido', [{ item: { type: 'track', id: 'corto' } }]],
    ['tipo desconocido', [{ item: { type: 'podcast', id: spotifyId(1) } }]],
    ['tipo ausente', [{ item: { id: spotifyId(1) } }]],
    ['item que no es objeto', [{ item: 'x' }]],
    ['is_local que no es booleano', [{ item: { ...TRACK, is_local: 'yes' } }]],
    ['una entrada válida seguida de una inválida', [{ item: TRACK }, {}]],
  ])(
    '/items con %s: aborta antes de cualquier POST y libera el candado',
    async (_name, entries) => {
      const ctx = setup();
      await ctx.register();
      ctx.hooks.override = (req) =>
        req.method === 'GET' && req.path.endsWith('/items')
          ? new Response(JSON.stringify(items(entries)))
          : undefined;

      await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);

      expect(ctx.posts()).toHaveLength(0);
      expect(await ctx.lockHeld()).toBe(false);
    },
  );

  it('item null, episodio y archivo local conservan su posición y la faltante se inserta en su lugar', async () => {
    const ctx = setup();
    await ctx.register();
    const episode = { item: { type: 'episode', id: 'ep' } };
    const local = { item: { type: 'track', is_local: true, id: null } };
    ctx.playlist.push({ item: null }, spotifyId(1), episode, local, spotifyId(3));

    await syncPlaylists(ctx.deps);

    expect(ctx.posts()).toHaveLength(1);
    expect(ctx.posts()[0]?.body).toEqual({ uris: [`spotify:track:${spotifyId(2)}`], position: 2 });
    expect(ctx.playlist).toEqual([
      { item: null },
      spotifyId(1),
      spotifyId(2),
      episode,
      local,
      spotifyId(3),
    ]);
  });

  it.each([
    ['entrada sin name', { id: PLAYLIST_ID, owner: { id: 'owner' } }],
    ['entrada sin owner', { id: PLAYLIST_ID, name: 'x' }],
    ['owner sin id', { id: PLAYLIST_ID, name: 'x', owner: {} }],
    ['entrada que no es objeto', 'x'],
  ])('/me/playlists con %s: no crea la playlist', async (_name, entry) => {
    const ctx = setup({ existingPlaylist: false });
    ctx.hooks.override = (req) =>
      req.method === 'GET' && req.path === '/me/playlists'
        ? new Response(JSON.stringify(items([entry])))
        : undefined;

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);

    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });

  it('una coincidencia con id inválido aborta antes de crear', async () => {
    const ctx = setup({ existingPlaylist: false });
    ctx.hooks.override = (req) =>
      req.method === 'GET' && req.path === '/me/playlists'
        ? new Response(
            JSON.stringify(
              items([{ id: 'corto', name: '365 Tracks 2027', owner: { id: 'owner' } }]),
            ),
          )
        : undefined;

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(SpotifyMetadataError);
    expect(ctx.posts()).toHaveLength(0);
  });
});

describe('5xx fuera de la lista de reintentos', () => {
  const status507 = () => new Response('{}', { status: 507 });

  it('un 507 en POST /items es ambiguo: un solo POST, candado vigente y otra ejecución lo omite', async () => {
    const ctx = setup();
    await ctx.register();
    ctx.hooks.override = (req) => (req.method === 'POST' ? status507() : undefined);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    expect(ctx.posts()).toHaveLength(1);
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    ctx.requests.length = 0;
    const second = await syncPlaylists(ctx.deps);
    expect(second.skippedLocked).toEqual([2027]);
    expect(ctx.requests).toEqual([]);
  });

  it('un 507 al crear la playlist también es ambiguo y conserva el candado', async () => {
    const ctx = setup({ existingPlaylist: false });
    ctx.hooks.override = (req) => (req.method === 'POST' ? status507() : undefined);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    expect(ctx.posts()).toHaveLength(1);
    ctx.requests.length = 0;
    expect((await syncPlaylists(ctx.deps)).skippedLocked).toEqual([2027]);
    expect(ctx.requests).toEqual([]);
  });

  it('un 507 en un GET no se reintenta y falla sin ser ambiguo ni escribir', async () => {
    const ctx = setup();
    await ctx.register();
    ctx.hooks.override = (req) =>
      req.method === 'GET' && req.path.endsWith('/items') ? status507() : undefined;

    const error = await syncPlaylists(ctx.deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect(error).not.toBeInstanceOf(AmbiguousSpotifyWriteError);
    expect(error).toMatchObject({ kind: 'server-error', status: 507 });
    expect(ctx.requests.filter((r) => r.path.endsWith('/items'))).toHaveLength(1);
    expect(ctx.posts()).toHaveLength(0);
    expect(await ctx.lockHeld()).toBe(false);
  });
});

describe('escritura ambigua', () => {
  const lateRequest = (ctx: ReturnType<typeof setup>) => {
    // El POST "se corta" para el cliente pero Spotify lo aplica más tarde.
    ctx.hooks.override = (req) => {
      if (req.method !== 'POST') return undefined;
      ctx.pending.push(() => void ctx.apply(req));
      ctx.hooks.override = undefined;
      return new TypeError('fetch failed');
    };
  };

  it('un timeout del primer POST corta el año: sin segunda escritura, sin markSynced y con el candado vigente', async () => {
    const ctx = setup({ days: 3 });
    await ctx.register();
    lateRequest(ctx);

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    expect(ctx.posts()).toHaveLength(1);
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    expect(await ctx.lockHeld()).toBe(true);

    // Otra ejecución dentro del TTL no lee ni escribe la playlist.
    ctx.requests.length = 0;
    ctx.clock.ms = T0 + 60 * SECOND;
    const during = await syncPlaylists(ctx.deps);
    expect(during.skippedLocked).toEqual([2027]);
    expect(ctx.requests).toEqual([]);
  });

  it('si Spotify aplica tarde pero antes de la siguiente lectura, la siguiente ejecución adopta sin duplicar', async () => {
    const ctx = setup({ days: 3 });
    await ctx.register();
    lateRequest(ctx);
    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    ctx.pending.forEach((applyLate) => applyLate());
    expect(ctx.playlist).toHaveLength(3);
    ctx.clock.ms = T0 + LOCK_TTL_MS + SECOND; // el candado venció solo
    ctx.requests.length = 0;

    const report = await syncPlaylists(ctx.deps);

    expect(report.years[0]?.adopted).toHaveLength(3);
    expect(report.years[0]?.added).toEqual([]);
    expect(ctx.posts()).toHaveLength(0);
    expect(ctx.playlist).toHaveLength(3);
    expect(await ctx.state.listSynced(2027)).toHaveLength(3);
  });

  it('riesgo residual: si Spotify aplica DESPUÉS de la siguiente lectura, la playlist queda duplicada', async () => {
    const ctx = setup({ days: 3 });
    await ctx.register();
    lateRequest(ctx);
    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    ctx.clock.ms = T0 + LOCK_TTL_MS + SECOND;
    await syncPlaylists(ctx.deps); // relee una playlist vacía y escribe las tres
    expect(ctx.playlist).toHaveLength(3);

    // La escritura "perdida" llega recién ahora (más de LOCK_TTL_MS después): duplica.
    ctx.pending.forEach((applyLate) => applyLate());
    expect(ctx.playlist).toHaveLength(6);

    // Política documentada: los duplicados existentes no se reparan ni se agrega nada más.
    ctx.clock.ms += LOCK_TTL_MS + SECOND;
    ctx.requests.length = 0;
    await syncPlaylists(ctx.deps);
    expect(ctx.posts()).toHaveLength(0);
    expect(ctx.playlist.filter((id) => id === spotifyId(1))).toHaveLength(2);
  });

  it('un TimeoutError real de AbortSignal en el POST es ambiguo: candado vigente y nada registrado', async () => {
    const ctx = setup();
    await ctx.register();
    ctx.hooks.override = (req) =>
      req.method === 'POST'
        ? new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        : undefined;

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    expect(ctx.posts()).toHaveLength(1);
    expect(await ctx.state.listSynced(2027)).toEqual([]);
    expect(await ctx.lockHeld()).toBe(true);
  });

  it('un 5xx al crear la playlist también es ambiguo y conserva el candado', async () => {
    const ctx = setup({ existingPlaylist: false });
    ctx.hooks.override = (req) =>
      req.method === 'POST' ? new Response('{}', { status: 503 }) : undefined;

    await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(AmbiguousSpotifyWriteError);

    expect(ctx.posts()).toHaveLength(1);
    expect(await ctx.lockHeld()).toBe(true);
  });

  it('el handler registra el fallo ambiguo sin títulos y lo propaga', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = setup();
    await ctx.register();
    lateRequest(ctx);

    await expect(createSyncPlaylistHandler(ctx.deps)()).rejects.toBeInstanceOf(
      AmbiguousSpotifyWriteError,
    );

    const logged = String(error.mock.calls[0]?.[0]);
    expect(logged).toContain('playlist-sync-ambiguous-write');
    expect(logged).not.toContain('Title');
    error.mockRestore();
  });
});
