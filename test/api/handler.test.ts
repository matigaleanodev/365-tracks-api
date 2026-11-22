import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../../src/api/app.ts';
import type { ErrorResponse, TrackListResponse, TrackResponse } from '../../src/api/contracts.ts';
import { encodeCursor } from '../../src/api/pagination.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { getCatalogStatus } from '../../src/tracks/catalog.ts';
import { buildDevFixtures } from '../../src/tracks/dev-fixtures.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { DESCRIPTION } from '../support/music.ts';

const NOW = new Date('2027-01-10T12:00:00Z');
const context = { getRemainingTimeInMillis: () => 30_000 } as unknown as Context;

function event(
  path: string,
  query?: Record<string, string>,
  method = 'GET',
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    rawPath: path,
    queryStringParameters: query,
    requestContext: { requestId: 'req-1', http: { method, path } },
  } as unknown as APIGatewayProxyEventV2;
}

async function call(
  repository: TrackRepository,
  request: APIGatewayProxyEventV2,
  now: Date = NOW,
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  const handler = createApiHandler({ repository, now: () => now });
  const response = (await handler(request, context)) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: response.statusCode as number,
    headers: response.headers as Record<string, string>,
    body: JSON.parse(response.body as string),
  };
}

const withFixtures = () => new InMemoryTrackRepository(buildDevFixtures(NOW, 5));

describe('GET /api/tracks/today', () => {
  it('devuelve la canción de la fecha UTC actual', async () => {
    const { statusCode, headers, body } = await call(withFixtures(), event('/api/tracks/today'));
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('application/json');
    expect((body as TrackResponse).data.date).toBe('2027-01-10');
  });

  it('responde 404 TRACK_NOT_FOUND sin datos', async () => {
    const { statusCode, body } = await call(
      new InMemoryTrackRepository(),
      event('/api/tracks/today'),
    );
    expect(statusCode).toBe(404);
    expect(body).toEqual<ErrorResponse>({
      error: {
        code: 'TRACK_NOT_FOUND',
        message: 'No track published for 2027-01-10',
        requestId: 'req-1',
      },
    });
  });
});

describe('GET /api/tracks/:date', () => {
  it('devuelve la canción de esa fecha', async () => {
    const { statusCode, body } = await call(withFixtures(), event('/api/tracks/2027-01-08'));
    expect(statusCode).toBe(200);
    expect((body as TrackResponse).data.title).toBe('Fixture Track 3');
  });

  it('omite los campos opcionales ausentes en lugar de enviarlos vacíos', async () => {
    const { body } = await call(withFixtures(), event('/api/tracks/2027-01-09'));
    expect((body as TrackResponse).data).not.toHaveProperty('coverUrl');
    expect((body as TrackResponse).data).toHaveProperty('description');
  });

  it('responde 400 INVALID_DATE ante una fecha inválida', async () => {
    const { statusCode, body } = await call(withFixtures(), event('/api/tracks/2027-02-30'));
    expect(statusCode).toBe(400);
    expect((body as ErrorResponse).error.code).toBe('INVALID_DATE');
  });

  it('responde 404 TRACK_NOT_FOUND si la fecha no tiene canción', async () => {
    const { statusCode, body } = await call(withFixtures(), event('/api/tracks/2020-01-01'));
    expect(statusCode).toBe(404);
    expect((body as ErrorResponse).error.code).toBe('TRACK_NOT_FOUND');
  });
});

describe('GET /api/tracks', () => {
  it('lista de la más reciente a la más antigua con paginación', async () => {
    const repository = withFixtures();

    const first = await call(repository, event('/api/tracks', { limit: '2' }));
    const firstBody = first.body as TrackListResponse;
    expect(firstBody.data.map((track) => track.date)).toEqual(['2027-01-10', '2027-01-09']);
    expect(firstBody.pagination.limit).toBe(2);
    expect(firstBody.pagination.nextCursor).toEqual(expect.any(String));

    const second = await call(
      repository,
      event('/api/tracks', { limit: '2', cursor: firstBody.pagination.nextCursor as string }),
    );
    expect((second.body as TrackListResponse).data.map((track) => track.date)).toEqual([
      '2027-01-08',
      '2027-01-07',
    ]);

    const third = await call(
      repository,
      event('/api/tracks', {
        limit: '2',
        cursor: (second.body as TrackListResponse).pagination.nextCursor as string,
      }),
    );
    const thirdBody = third.body as TrackListResponse;
    expect(thirdBody.data.map((track) => track.date)).toEqual(['2027-01-06']);
    expect(thirdBody.pagination.nextCursor).toBeNull();
  });

  it('devuelve lista vacía sin datos', async () => {
    const { statusCode, body } = await call(new InMemoryTrackRepository(), event('/api/tracks'));
    expect(statusCode).toBe(200);
    expect(body).toEqual<TrackListResponse>({
      data: [],
      pagination: { limit: 30, nextCursor: null },
    });
  });

  it('responde 400 INVALID_QUERY_PARAMETER ante limit o cursor inválidos', async () => {
    const queries: Record<string, string>[] = [{ limit: '0' }, { limit: 'x' }, { cursor: 'nope' }];
    for (const query of queries) {
      const { statusCode, body } = await call(withFixtures(), event('/api/tracks', query));
      expect(statusCode).toBe(400);
      expect((body as ErrorResponse).error.code).toBe('INVALID_QUERY_PARAMETER');
    }
  });
});

describe('errores', () => {
  it('responde 404 ROUTE_NOT_FOUND para rutas o métodos no definidos', async () => {
    for (const request of [event('/api/unknown'), event('/api/tracks', undefined, 'POST')]) {
      const { statusCode, body } = await call(withFixtures(), request);
      expect(statusCode).toBe(404);
      expect((body as ErrorResponse).error.code).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('oculta los detalles de errores inesperados', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: TrackRepository = {
      getByDate: () => Promise.reject(new Error('secret connection string')),
      list: () => Promise.reject(new Error('secret connection string')),
      create: () => Promise.reject(new Error('secret connection string')),
    };
    const { statusCode, body } = await call(broken, event('/api/tracks/today'));
    expect(statusCode).toBe(500);
    expect(body).toEqual<ErrorResponse>({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-1' },
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    consoleError.mockRestore();
  });
});

describe('publicaciones futuras y previas al lanzamiento', () => {
  const track = (date: string): DailyTrack => ({
    date,
    title: `Track ${date}`,
    artist: 'Artist',
    album: 'Album',
    releaseYear: 1999,
    spotifyTrackId: 'abcdefghijklmnopqrstuv',
    spotifyUrl: 'https://open.spotify.com/track/abcdefghijklmnopqrstuv',
    selectionCriterion: 'test',
    description: DESCRIPTION,
    createdAt: '2026-12-01T00:00:00.000Z',
  });
  const dates = (body: unknown) => (body as TrackListResponse).data.map((item) => item.date);

  it('GET /api/tracks/:date responde 404 para una fecha futura aunque exista en la tabla', async () => {
    const repository = new InMemoryTrackRepository([track('2027-01-11'), track('2027-01-10')]);
    const future = await call(repository, event('/api/tracks/2027-01-11'));
    expect(future.statusCode).toBe(404);
    expect((future.body as ErrorResponse).error.code).toBe('TRACK_NOT_FOUND');
    expect((await call(repository, event('/api/tracks/2027-01-10'))).statusCode).toBe(200);
  });

  it('una fecha futura pasa a ser pública cuando llega su día UTC', async () => {
    const repository = new InMemoryTrackRepository([track('2027-01-11')]);
    const before = new Date('2027-01-10T23:59:59Z');
    const after = new Date('2027-01-11T00:00:00Z');
    expect((await call(repository, event('/api/tracks/2027-01-11'), before)).statusCode).toBe(404);
    expect((await call(repository, event('/api/tracks/2027-01-11'), after)).statusCode).toBe(200);
    expect((await call(repository, event('/api/tracks/today'), after)).statusCode).toBe(200);
  });

  it('GET /api/tracks no incluye canciones futuras', async () => {
    const repository = new InMemoryTrackRepository([
      track('2027-01-12'),
      track('2027-01-11'),
      track('2027-01-10'),
      track('2027-01-09'),
    ]);
    const { body } = await call(repository, event('/api/tracks'));
    expect(dates(body)).toEqual(['2027-01-10', '2027-01-09']);
  });

  it('un cursor futuro no abre el acceso a canciones futuras', async () => {
    const repository = new InMemoryTrackRepository([track('2027-01-11'), track('2027-01-10')]);
    const cursor = encodeCursor('2027-02-01');
    const { statusCode, body } = await call(repository, event('/api/tracks', { cursor }));
    expect(statusCode).toBe(200);
    expect(dates(body)).toEqual(['2027-01-10']);
  });

  it('la paginación sigue siendo consistente con canciones futuras en la tabla', async () => {
    const repository = new InMemoryTrackRepository([
      track('2027-01-12'),
      track('2027-01-10'),
      track('2027-01-09'),
      track('2027-01-08'),
    ]);
    const first = (await call(repository, event('/api/tracks', { limit: '2' }))).body;
    expect(dates(first)).toEqual(['2027-01-10', '2027-01-09']);
    const cursor = (first as TrackListResponse).pagination.nextCursor as string;
    const second = (await call(repository, event('/api/tracks', { limit: '2', cursor }))).body;
    expect(dates(second)).toEqual(['2027-01-08']);
    expect((second as TrackListResponse).pagination.nextCursor).toBeNull();
  });

  it('nada anterior al 2027-01-01 es público: ni por fecha, ni en today, ni en el historial', async () => {
    const repository = new InMemoryTrackRepository([
      track('2027-01-02'),
      track('2027-01-01'),
      track('2026-12-31'),
      track('2026-11-21'),
    ]);
    const preLaunch = new Date('2026-12-31T23:59:59Z');
    expect((await call(repository, event('/api/tracks/2026-12-31'), preLaunch)).statusCode).toBe(
      404,
    );
    expect((await call(repository, event('/api/tracks/today'), preLaunch)).statusCode).toBe(404);
    expect((await call(repository, event('/api/tracks'), preLaunch)).body).toEqual({
      data: [],
      pagination: { limit: 30, nextCursor: null },
    });

    const launched = new Date('2027-01-02T08:00:00Z');
    expect((await call(repository, event('/api/tracks/2026-12-31'), launched)).statusCode).toBe(
      404,
    );
    const { body } = await call(repository, event('/api/tracks'), launched);
    expect(dates(body)).toEqual(['2027-01-02', '2027-01-01']);
    expect((body as TrackListResponse).pagination.nextCursor).toBeNull();
  });

  it('la fecha editorial se calcula en UTC, no en hora local', async () => {
    const repository = new InMemoryTrackRepository([track('2027-01-01')]);
    // 2026-12-31 21:00 en Buenos Aires ya es 2027-01-01 en UTC.
    const instant = new Date('2026-12-31T21:00:00-03:00');
    expect((await call(repository, event('/api/tracks/today'), instant)).statusCode).toBe(200);
  });

  it('ninguna consulta a un día no publicado llega al repositorio de lectura por fecha', async () => {
    const getByDate = vi.fn(() => Promise.resolve(null));
    const repository = { getByDate } as unknown as TrackRepository;
    await call(repository, event('/api/tracks/2027-03-01'));
    expect(getByDate).not.toHaveBeenCalled();
  });
});

describe('publicación por zona horaria', () => {
  const track = (date: string, id = 'abcdefghijklmnopqrstuv'): DailyTrack => ({
    date,
    title: `Track ${date}`,
    artist: 'Artist',
    album: 'Album',
    releaseYear: 1999,
    spotifyTrackId: id,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    selectionCriterion: 'test',
    description: DESCRIPTION,
    createdAt: '2026-12-01T00:00:00.000Z',
  });
  const catalog = () =>
    new InMemoryTrackRepository([
      track('2027-01-03'),
      track('2027-01-02'),
      track('2027-01-01'),
      track('2026-12-31'),
    ]);
  const dates = (body: unknown) => (body as TrackListResponse).data.map((item) => item.date);
  const today = async (repository: TrackRepository, now: Date, timezone?: string) =>
    call(repository, event('/api/tracks/today', timezone ? { timezone } : undefined), now);

  const ARGENTINA = 'America/Argentina/Buenos_Aires';

  it('la canción del 1 de enero abre a las 00:00 locales en Argentina, España y Japón', async () => {
    const repository = catalog();
    const opening: [string, string][] = [
      [ARGENTINA, '2027-01-01T03:00:00Z'],
      ['Europe/Madrid', '2026-12-31T23:00:00Z'],
      ['Asia/Tokyo', '2026-12-31T15:00:00Z'],
      ['UTC', '2027-01-01T00:00:00Z'],
    ];
    for (const [zone, instant] of opening) {
      const open = new Date(instant);
      const before = new Date(open.getTime() - 1000);
      expect((await today(repository, before, zone)).statusCode, `${zone} antes`).toBe(404);
      const response = await today(repository, open, zone);
      expect(response.statusCode, `${zone} apertura`).toBe(200);
      expect((response.body as TrackResponse).data.date).toBe('2027-01-01');
    }
  });

  it('todas las zonas comparten la misma canción para cada fecha', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T12:00:00Z');
    const titles = new Set<string>();
    for (const zone of [ARGENTINA, 'Europe/Madrid', 'Asia/Tokyo', 'UTC']) {
      const response = await today(repository, instant, zone);
      titles.add((response.body as TrackResponse).data.title);
    }
    expect(titles).toEqual(new Set(['Track 2027-01-02']));
  });

  it('el reloj es del servidor: en el mismo instante cada zona ve su propio hoy', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T01:00:00Z');
    const dateIn = async (zone: string) =>
      ((await today(repository, instant, zone)).body as TrackResponse).data.date;
    expect(await dateIn(ARGENTINA)).toBe('2027-01-01');
    expect(await dateIn('UTC')).toBe('2027-01-02');
    expect(await dateIn('Asia/Tokyo')).toBe('2027-01-02');
  });

  it('sin timezone rige UTC (compatibilidad)', async () => {
    const instant = new Date('2027-01-02T01:00:00Z');
    const response = await today(catalog(), instant);
    expect((response.body as TrackResponse).data.date).toBe('2027-01-02');
  });

  it('antes del lanzamiento nada es público, ni siquiera en la zona más adelantada fuera de hora', async () => {
    const repository = catalog();
    // 2026-12-31 09:59Z: Kiritimati (UTC+14) todavía está en el 2026-12-31 → 23:59.
    const early = new Date('2026-12-31T09:59:59Z');
    expect((await today(repository, early, 'Pacific/Kiritimati')).statusCode).toBe(404);
    expect(
      (
        await call(
          repository,
          event('/api/tracks/2026-12-31', { timezone: 'Pacific/Kiritimati' }),
          early,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call(repository, event('/api/tracks', { timezone: 'Pacific/Kiritimati' }), early))
        .body,
    ).toEqual({
      data: [],
      pagination: { limit: 30, nextCursor: null },
    });
    // Un segundo después, en Kiritimati ya es 2027-01-01.
    const open = new Date('2026-12-31T10:00:00Z');
    expect(
      ((await today(repository, open, 'Pacific/Kiritimati')).body as TrackResponse).data.date,
    ).toBe('2027-01-01');
  });

  it('una zona adelantada no anticipa canciones a otra: la fecha futura sigue oculta', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T10:00:00Z'); // Kiritimati ya es 2027-01-03
    const ahead = await call(
      repository,
      event('/api/tracks/2027-01-03', { timezone: 'Pacific/Kiritimati' }),
      instant,
    );
    const behind = await call(
      repository,
      event('/api/tracks/2027-01-03', { timezone: ARGENTINA }),
      instant,
    );
    const utc = await call(repository, event('/api/tracks/2027-01-03'), instant);
    expect(ahead.statusCode).toBe(200);
    expect(behind.statusCode).toBe(404);
    expect(utc.statusCode).toBe(404);
  });

  it('el historial respeta la zona: lista hasta el hoy local y ningún cursor lo supera', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T01:00:00Z'); // Argentina: 2027-01-01
    const ar = await call(repository, event('/api/tracks', { timezone: ARGENTINA }), instant);
    expect(dates(ar.body)).toEqual(['2027-01-01']);
    const utc = await call(repository, event('/api/tracks'), instant);
    expect(dates(utc.body)).toEqual(['2027-01-02', '2027-01-01']);
    const forged = await call(
      repository,
      event('/api/tracks', { timezone: ARGENTINA, cursor: encodeCursor('2027-02-01') }),
      instant,
    );
    expect(dates(forged.body)).toEqual(['2027-01-01']);
  });

  it('paginar con cursor y zona horaria nunca revela una fecha futura', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-03T02:00:00Z'); // Argentina: 2027-01-02
    const query = { timezone: ARGENTINA, limit: '1' };
    const first = await call(repository, event('/api/tracks', query), instant);
    expect(dates(first.body)).toEqual(['2027-01-02']);
    const cursor = (first.body as TrackListResponse).pagination.nextCursor as string;
    const second = await call(repository, event('/api/tracks', { ...query, cursor }), instant);
    expect(dates(second.body)).toEqual(['2027-01-01']);
    expect((second.body as TrackListResponse).pagination.nextCursor).toBeNull();
  });

  it('un cursor emitido en una zona adelantada es acotado al consultar desde una zona atrasada', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T10:00:00Z'); // Kiritimati: 03, Argentina: 02
    const cursor = encodeCursor('2027-01-04');
    const response = await call(
      repository,
      event('/api/tracks', { timezone: ARGENTINA, cursor }),
      instant,
    );
    expect(dates(response.body)).toEqual(['2027-01-02', '2027-01-01']);
  });

  it.each(['Mars/Olympus', '', '+03:00', 'UTC+3', 'Europe/Madrid; x'])(
    'rechaza la zona inválida "%s" con 400 INVALID_QUERY_PARAMETER en las tres rutas',
    async (timezone) => {
      const repository = catalog();
      for (const path of ['/api/tracks/today', '/api/tracks/2027-01-01', '/api/tracks']) {
        const { statusCode, body } = await call(repository, event(path, { timezone }));
        expect(statusCode, path).toBe(400);
        expect((body as ErrorResponse).error.code).toBe('INVALID_QUERY_PARAMETER');
        expect((body as ErrorResponse).error.message).toContain('timezone');
      }
    },
  );

  it('una fecha inválida sigue siendo INVALID_DATE y la zona inválida no la enmascara en rutas válidas', async () => {
    const { body } = await call(
      catalog(),
      event('/api/tracks/2027-02-30', { timezone: ARGENTINA }),
    );
    expect((body as ErrorResponse).error.code).toBe('INVALID_DATE');
  });

  it('las respuestas (éxito y error) no se cachean de forma compartida', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T12:00:00Z');
    const ok = await today(repository, instant, ARGENTINA);
    const notFound = await call(repository, event('/api/tracks/2027-01-03'), instant);
    const bad = await call(repository, event('/api/tracks', { timezone: 'x/y/z/w' }), instant);
    for (const response of [ok, notFound, bad]) {
      expect(response.headers['cache-control']).toBe('private, no-cache');
    }
  });

  it('la zona horaria no altera la fecha editorial almacenada', async () => {
    const repository = catalog();
    const instant = new Date('2027-01-02T12:00:00Z');
    const { body } = await call(
      repository,
      event('/api/tracks/2027-01-01', { timezone: 'Asia/Tokyo' }),
      instant,
    );
    expect((body as TrackResponse).data).toEqual(track('2027-01-01'));
  });
});

describe('datos internos', () => {
  const internal: DailyTrack = {
    date: '2027-01-10',
    title: 'Internal',
    artist: 'Artist',
    album: 'Album',
    releaseYear: 1999,
    spotifyTrackId: 'abcdefghijklmnopqrstuv',
    spotifyUrl: 'https://open.spotify.com/track/abcdefghijklmnopqrstuv',
    selectionCriterion: 'hidden-gem',
    description:
      'Una canción de guitarras luminosas y base rítmica directa, pensada para arrancar el día.',
    createdAt: '2026-12-01T00:00:00.000Z',
    spotifyArtistId: 'artist00000000000000AA',
  };
  const repository = () => new InMemoryTrackRepository([internal]);

  it('el ID de artista de Spotify no sale por la API (contrato HTTP sin cambios)', async () => {
    const single = await call(repository(), event('/api/tracks/2027-01-10'));
    const list = await call(repository(), event('/api/tracks'));
    const today = await call(repository(), event('/api/tracks/today'));

    expect((single.body as TrackResponse).data).not.toHaveProperty('spotifyArtistId');
    expect((list.body as TrackListResponse).data[0]).not.toHaveProperty('spotifyArtistId');
    expect((today.body as TrackResponse).data).not.toHaveProperty('spotifyArtistId');
    expect((single.body as TrackResponse).data.description).toBe(internal.description);
  });

  it('las particiones de la playlist no aparecen en el listado de canciones', async () => {
    const list = await call(repository(), event('/api/tracks'));
    expect((list.body as TrackListResponse).data).toHaveLength(1);
  });
});

describe('canciones incompletas', () => {
  const complete = (date: string, n = 1): DailyTrack => ({
    date,
    title: `Track ${date}`,
    artist: `Artist ${n}`,
    album: 'Album',
    releaseYear: 1999,
    spotifyTrackId: `track${String(n).padStart(17, '0')}`,
    spotifyUrl: `https://open.spotify.com/track/track${String(n).padStart(17, '0')}`,
    selectionCriterion: 'test',
    description: DESCRIPTION,
    createdAt: '2026-12-01T00:00:00.000Z',
  });
  const broken: [string, Partial<DailyTrack>][] = [
    ['sin descripción', { description: undefined }],
    ['descripción con una cita', { description: `${DESCRIPTION} "cita"` }],
    ['descripción demasiado corta', { description: 'Corta.' }],
    ['título vacío', { title: '  ' }],
    ['sin enlace de Spotify', { spotifyUrl: '' }],
    ['año inválido', { releaseYear: 1999.5 }],
  ];
  const repositoryWith = (...tracks: DailyTrack[]) => new InMemoryTrackRepository(tracks);

  it.each(broken)(
    '%s: /today, por fecha e historial responden como si no existiera',
    async (_name, overrides) => {
      const repository = repositoryWith(complete('2027-01-09', 1), {
        ...complete('2027-01-10', 2),
        ...overrides,
      });

      const today = await call(repository, event('/api/tracks/today'));
      const byDate = await call(repository, event('/api/tracks/2027-01-10'));
      const history = await call(repository, event('/api/tracks'));

      expect(today.statusCode).toBe(404);
      expect(byDate.statusCode).toBe(404);
      expect((byDate.body as ErrorResponse).error.code).toBe('TRACK_NOT_FOUND');
      expect(dates(history.body)).toEqual(['2027-01-09']);
      // Mismo cuerpo que una fecha sin ningún registro: no revela que está en preparación.
      const missing = await call(repository, event('/api/tracks/2027-01-08'));
      expect((byDate.body as ErrorResponse).error.message.replace('2027-01-10', 'X')).toBe(
        (missing.body as ErrorResponse).error.message.replace('2027-01-08', 'X'),
      );
    },
  );

  const dates = (body: unknown) => (body as TrackListResponse).data.map((item) => item.date);

  it('no modifica ni sobrescribe el registro incompleto', async () => {
    const incomplete = { ...complete('2027-01-10', 2), description: undefined } as DailyTrack;
    const repository = repositoryWith(incomplete);
    await call(repository, event('/api/tracks/2027-01-10'));
    await call(repository, event('/api/tracks'));
    expect(await repository.getByDate('2027-01-10')).toEqual(incomplete);
  });

  it('la paginación es estable con incompletas intercaladas: sin duplicados ni saltos', async () => {
    // 2027-01-01 … 2027-01-10; incompletas: 03, 06, 07 y 10.
    const incompleteDays = new Set(['2027-01-03', '2027-01-06', '2027-01-07', '2027-01-10']);
    const tracks = Array.from({ length: 10 }, (_, index) => {
      const date = `2027-01-${String(index + 1).padStart(2, '0')}`;
      const track = complete(date, index + 1);
      return incompleteDays.has(date) ? { ...track, description: undefined } : track;
    }) as DailyTrack[];
    const repository = repositoryWith(...tracks);

    for (const limit of [1, 2, 3, 4, 6]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 30; pages += 1) {
        const response = await call(
          repository,
          event('/api/tracks', { limit: String(limit), ...(cursor ? { cursor } : {}) }),
        );
        const body = response.body as TrackListResponse;
        expect(body.data.length).toBeLessThanOrEqual(limit);
        seen.push(...dates(body));
        if (body.pagination.nextCursor === null) break;
        cursor = body.pagination.nextCursor;
        expect(pages).toBeLessThan(29); // sin bucles
      }
      expect(seen).toEqual([
        '2027-01-09',
        '2027-01-08',
        '2027-01-05',
        '2027-01-04',
        '2027-01-02',
        '2027-01-01',
      ]);
    }
  });

  it('con las páginas llenas la primera respuesta ya trae `limit` canciones completas', async () => {
    const repository = repositoryWith(
      complete('2027-01-08', 1),
      { ...complete('2027-01-09', 2), description: undefined } as DailyTrack,
      complete('2027-01-10', 3),
      complete('2027-01-07', 4),
    );
    const response = await call(repository, event('/api/tracks', { limit: '2' }));
    const body = response.body as TrackListResponse;
    expect(dates(body)).toEqual(['2027-01-10', '2027-01-08']);
    expect(body.pagination.nextCursor).toEqual(expect.any(String));
  });

  it('una racha de incompletas más larga que el límite no devuelve páginas vacías', async () => {
    const tracks = [
      complete('2027-01-01', 1),
      ...Array.from({ length: 11 }, (_, index) => ({
        ...complete(`2027-01-${String(index + 2).padStart(2, '0')}`, index + 2),
        description: undefined,
      })),
    ] as DailyTrack[];
    const body = (await call(repositoryWith(...tracks), event('/api/tracks', { limit: '1' })))
      .body as TrackListResponse;
    expect(dates(body)).toEqual(['2027-01-01']);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it('no ofrece cursor si lo que queda es solo incompleto', async () => {
    const tracks = [
      complete('2027-01-02', 2),
      { ...complete('2027-01-01', 1), description: undefined },
    ] as DailyTrack[];
    const body = (await call(repositoryWith(...tracks), event('/api/tracks', { limit: '1' })))
      .body as TrackListResponse;
    expect(dates(body)).toEqual(['2027-01-02']);
    expect(body.pagination.nextCursor).toBeNull();
  });

  it('una racha larga de incompletas no crea bucles: el cursor siempre avanza', async () => {
    // 2027-01-01 completa; 2027-01-02 … 2027-01-10 incompletas.
    const tracks = [
      complete('2027-01-01', 1),
      ...Array.from({ length: 9 }, (_, index) => ({
        ...complete(`2027-01-${String(index + 2).padStart(2, '0')}`, index + 2),
        description: undefined,
      })),
    ] as DailyTrack[];
    const repository = repositoryWith(...tracks);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages += 1) {
      const response = await call(
        repository,
        event('/api/tracks', { limit: '1', ...(cursor ? { cursor } : {}) }),
      );
      const body = response.body as TrackListResponse;
      seen.push(...dates(body));
      if (body.pagination.nextCursor === null) break;
      expect(body.pagination.nextCursor).not.toBe(cursor);
      cursor = body.pagination.nextCursor;
    }
    expect(seen).toEqual(['2027-01-01']);
  });

  it('el registro incompleto sigue visible para el estado interno del catálogo', async () => {
    const repository = repositoryWith({
      ...complete('2027-01-10', 2),
      description: undefined,
    } as DailyTrack);
    const status = await getCatalogStatus(repository, ['2027-01-10']);
    expect(status.incomplete).toEqual(['2027-01-10']);
    expect(status.prepared).toEqual([]);
  });
});
