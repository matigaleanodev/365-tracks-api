import { describe, expect, it, vi } from 'vitest';
import { createSpotifyClient, parseSpotifyTrack } from '../../src/spotify/client.ts';
import { SpotifyMetadataError, SpotifyTrackNotFoundError } from '../../src/spotify/errors.ts';
import type { HttpPolicy } from '../../src/shared/resilient-fetch.ts';

const TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';
const ARTIST_ID = '6ZLTlhejhndI4Rh53vYhrY';

const rawTrack = (overrides: Record<string, unknown> = {}) => ({
  id: TRACK_ID,
  type: 'track',
  name: 'Blue Monday',
  artists: [{ id: ARTIST_ID, name: 'New Order' }],
  album: {
    name: 'Power, Corruption & Lies',
    album_type: 'album',
    release_date: '1983-05-02',
    images: [
      { url: 'http://insecure.example/a.jpg' },
      { url: 'https://i.scdn.co/image/large' },
      { url: 'https://i.scdn.co/image/small' },
    ],
  },
  ...overrides,
});

describe('parseSpotifyTrack', () => {
  it('extrae título, artista principal, álbum, año, enlace y portada https', () => {
    expect(parseSpotifyTrack(rawTrack())).toEqual({
      id: TRACK_ID,
      title: 'Blue Monday',
      artist: 'New Order',
      artistId: ARTIST_ID,
      artists: [{ id: ARTIST_ID, name: 'New Order' }],
      album: 'Power, Corruption & Lies',
      albumType: 'album',
      releaseYear: 1983,
      releaseDate: '1983-05-02',
      releaseDatePrecision: 'day',
      url: `https://open.spotify.com/track/${TRACK_ID}`,
      coverUrl: 'https://i.scdn.co/image/large',
    });
  });

  it('una portada ausente no invalida la canción', () => {
    const track = parseSpotifyTrack(rawTrack({ album: { name: 'A', release_date: '1990' } }));
    expect(track).not.toBeNull();
    expect(track).not.toHaveProperty('coverUrl');
    expect(track).toMatchObject({ releaseYear: 1990, releaseDatePrecision: 'year' });
  });

  it.each([
    ['2001-07', 'month'],
    ['2001-07-09', 'day'],
  ])('la precisión de %s es %s', (date, precision) => {
    const track = parseSpotifyTrack(rawTrack({ album: { name: 'A', release_date: date } }));
    expect(track?.releaseDatePrecision).toBe(precision);
  });

  it.each([
    ['sin ID', { id: undefined }],
    ['ID inválido', { id: 'corto' }],
    ['sin título', { name: ' ' }],
    ['sin artistas', { artists: [] }],
    ['artista sin ID válido', { artists: [{ id: 'x', name: 'Alguien' }] }],
    ['sin álbum', { album: undefined }],
    ['álbum sin nombre', { album: { release_date: '1990' } }],
    ['sin fecha de lanzamiento', { album: { name: 'A' } }],
    ['fecha de lanzamiento inválida', { album: { name: 'A', release_date: 'ayer' } }],
    ['no es una canción (episodio)', { type: 'episode' }],
  ])('metadatos incompletos: %s → null', (_name, overrides) => {
    expect(parseSpotifyTrack(rawTrack(overrides))).toBeNull();
  });

  it('no es un objeto → null', () => {
    expect(parseSpotifyTrack(null)).toBeNull();
    expect(parseSpotifyTrack('x')).toBeNull();
  });
});

const policy: HttpPolicy = {
  timeoutMs: 1000,
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 1,
  maxRetryAfterMs: 1,
};

function client(responses: Response[]) {
  const queue = [...responses];
  const fetchMock = vi.fn(() => {
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'));
  });
  const getAccessToken = vi.fn(() => Promise.resolve('token-123'));
  const spotify = createSpotifyClient({
    tokens: { getAccessToken },
    policy,
    http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
  });
  return { spotify, fetchMock, getAccessToken };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urlOf = (mock: ReturnType<typeof vi.fn>, call: number) =>
  new URL((mock.mock.calls[call] as unknown as [string])[0]);

describe('createSpotifyClient.getTrack', () => {
  it('consulta por ID con el token y devuelve los metadatos', async () => {
    const { spotify, fetchMock } = client([json(rawTrack())]);
    await expect(spotify.getTrack(TRACK_ID)).resolves.toMatchObject({ title: 'Blue Monday' });
    expect(urlOf(fetchMock, 0).pathname).toBe(`/v1/tracks/${TRACK_ID}`);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-123');
  });

  it('cachea por ID: la segunda lectura no vuelve a llamar', async () => {
    const { spotify, fetchMock } = client([json(rawTrack())]);
    await spotify.getTrack(TRACK_ID);
    await spotify.getTrack(TRACK_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un 404 se informa como canción inexistente', async () => {
    const { spotify } = client([json({ error: 'not found' }, 404)]);
    await expect(spotify.getTrack(TRACK_ID)).rejects.toBeInstanceOf(SpotifyTrackNotFoundError);
  });

  it('rechaza un ID con formato inválido sin llamar a Spotify', async () => {
    const { spotify, fetchMock } = client([]);
    await expect(spotify.getTrack('../me')).rejects.toBeInstanceOf(SpotifyMetadataError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('metadatos incompletos de Spotify se rechazan, no se completan', async () => {
    const { spotify } = client([json(rawTrack({ artists: [] }))]);
    await expect(spotify.getTrack(TRACK_ID)).rejects.toBeInstanceOf(SpotifyMetadataError);
  });

  it('propaga un rate limit definitivo con su Retry-After', async () => {
    const limited = new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
    const { spotify } = client([limited]);
    await expect(spotify.getTrack(TRACK_ID)).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 3_600_000,
    });
  });
});

describe('createSpotifyClient.searchTracks', () => {
  const page = (...items: unknown[]) => json({ tracks: { items } });

  it('busca con filtros de campo y limit 10', async () => {
    const { spotify, fetchMock } = client([page(rawTrack())]);
    const results = await spotify.searchTracks({ title: 'Blue Monday', artist: 'New Order' });
    expect(results).toHaveLength(1);
    const url = urlOf(fetchMock, 0);
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('q')).toBe('track:"Blue Monday" artist:"New Order"');
    expect(url.searchParams.get('type')).toBe('track');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('si los filtros no devuelven nada, reintenta con texto libre', async () => {
    const { spotify, fetchMock } = client([page(), page(rawTrack())]);
    const results = await spotify.searchTracks({ title: 'Blue Monday', artist: 'New Order' });
    expect(results).toHaveLength(1);
    expect(urlOf(fetchMock, 1).searchParams.get('q')).toBe('Blue Monday New Order');
  });

  it('descarta resultados sin metadatos completos y conserva el resto', async () => {
    const { spotify } = client([page(rawTrack({ artists: [] }), rawTrack())]);
    const results = await spotify.searchTracks({ title: 'Blue Monday', artist: 'New Order' });
    expect(results.map((track) => track.id)).toEqual([TRACK_ID]);
  });

  it('las comillas del título no rompen el filtro', async () => {
    const { spotify, fetchMock } = client([page(rawTrack())]);
    await spotify.searchTracks({ title: 'Say "Yes"', artist: 'Band' });
    expect(urlOf(fetchMock, 0).searchParams.get('q')).toBe('track:"Say Yes" artist:"Band"');
  });

  it('un título o artista vacío no consulta', async () => {
    const { spotify, fetchMock } = client([]);
    await expect(spotify.searchTracks({ title: '"', artist: 'Band' })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una respuesta sin la forma esperada falla de forma explícita', async () => {
    const { spotify } = client([json({ unexpected: true })]);
    await expect(spotify.searchTracks({ title: 'A', artist: 'B' })).rejects.toBeInstanceOf(
      SpotifyMetadataError,
    );
  });

  it('un error de Spotify no incluye el título buscado en el mensaje', async () => {
    const { spotify } = client([json({ error: 'boom' }, 400)]);
    const error = (await spotify
      .searchTracks({ title: 'Titulo Secreto', artist: 'Artista Secreto' })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('Secreto');
  });
});
