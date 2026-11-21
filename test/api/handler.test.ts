import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../../src/api/app.ts';
import type { ErrorResponse, TrackListResponse, TrackResponse } from '../../src/api/contracts.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import { buildDevFixtures } from '../../src/tracks/dev-fixtures.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';

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
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  const handler = createApiHandler({ repository, now: () => NOW });
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
    expect((body as TrackResponse).data).not.toHaveProperty('description');
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
