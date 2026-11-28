import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../../src/api/app.ts';
import type { TrackListResponse, TrackResponse } from '../../src/api/contracts.ts';
import { encodeCursor } from '../../src/api/pagination.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { preparedTrack } from '../support/music.ts';

const context = { getRemainingTimeInMillis: () => 30_000 } as unknown as Context;

/** Catálogo del 1 al 5 de marzo de 2027, más una incompleta el 6 (que nunca se publica). */
const catalog = () =>
  new InMemoryTrackRepository([
    ...[1, 2, 3, 4, 5].map((day) => preparedTrack(`2027-03-0${day}`, day)),
    preparedTrack('2027-03-06', 6, { description: undefined }),
  ]);

async function get(path: string, query: Record<string, string>, now: Date) {
  const handler = createApiHandler({ repository: catalog(), now: () => now });
  const request = {
    version: '2.0',
    rawPath: path,
    queryStringParameters: query,
    requestContext: { requestId: 'req', http: { method: 'GET', path } },
  } as unknown as APIGatewayProxyEventV2;
  const response = (await handler(request, context)) as APIGatewayProxyStructuredResultV2;
  return { status: response.statusCode, body: JSON.parse(response.body as string) as unknown };
}

const listDates = (body: unknown) => (body as TrackListResponse).data.map((t) => t.date);

/**
 * Para cada zona extrema, el último segundo antes de las 00:00 locales del 3 de marzo y el primero
 * del día. Antes: el 3 no es visible por ninguna ruta. Después: lo es, y el 4 sigue oculto.
 */
const BOUNDARIES: { zone: string; before: string; after: string }[] = [
  { zone: 'Pacific/Kiritimati', before: '2027-03-02T09:59:59Z', after: '2027-03-02T10:00:00Z' },
  { zone: 'Pacific/Chatham', before: '2027-03-02T10:14:59Z', after: '2027-03-02T10:15:00Z' },
  { zone: 'Asia/Kathmandu', before: '2027-03-02T18:14:59Z', after: '2027-03-02T18:15:00Z' },
  { zone: 'UTC', before: '2027-03-02T23:59:59Z', after: '2027-03-03T00:00:00Z' },
  { zone: 'Pacific/Marquesas', before: '2027-03-03T09:29:59Z', after: '2027-03-03T09:30:00Z' },
  { zone: 'Etc/GMT+12', before: '2027-03-03T11:59:59Z', after: '2027-03-03T12:00:00Z' },
];

describe('visibilidad en zonas extremas: las tres rutas al segundo exacto', () => {
  for (const { zone, before, after } of BOUNDARIES) {
    it(`${zone}: el 3 de marzo se abre a las 00:00 locales y el 4 sigue oculto`, async () => {
      const timezone = zone;
      const early = new Date(before);
      const open = new Date(after);

      const todayEarly = await get('/api/tracks/today', { timezone }, early);
      expect((todayEarly.body as TrackResponse).data.date).toBe('2027-03-02');
      expect((await get('/api/tracks/2027-03-03', { timezone }, early)).status).toBe(404);
      expect(listDates((await get('/api/tracks', { timezone }, early)).body)[0]).toBe('2027-03-02');

      const todayOpen = await get('/api/tracks/today', { timezone }, open);
      expect((todayOpen.body as TrackResponse).data.date).toBe('2027-03-03');
      expect((await get('/api/tracks/2027-03-03', { timezone }, open)).status).toBe(200);
      expect((await get('/api/tracks/2027-03-04', { timezone }, open)).status).toBe(404);
      const history = listDates((await get('/api/tracks', { timezone }, open)).body);
      expect(history[0]).toBe('2027-03-03');
      expect(history).not.toContain('2027-03-04');
    });
  }

  it('ninguna manipulación de parámetros revela una fecha futura ni una incompleta', async () => {
    // 2027-03-05 09:00 UTC: incluso en UTC+14 todavía es 5 de marzo (el 6 empieza a las 10:00 UTC).
    const now = new Date('2027-03-05T09:00:00Z');
    const futureCursor = encodeCursor('2099-01-01');
    const queries: Record<string, string>[] = [
      { timezone: 'Pacific/Kiritimati', cursor: futureCursor },
      { timezone: 'Pacific/Kiritimati', limit: '100' },
      { timezone: 'Etc/GMT-14' },
    ];
    for (const query of queries) {
      const dates = listDates((await get('/api/tracks', query, now)).body);
      expect(dates.every((date) => date <= '2027-03-05')).toBe(true);
    }
    // El 6 ya empezó en UTC+14 a las 10:00 UTC del 5, pero está incompleta: no se publica.
    const later = new Date('2027-03-05T10:00:00Z');
    const kiritimati = { timezone: 'Pacific/Kiritimati' };
    expect((await get('/api/tracks/2027-03-06', kiritimati, later)).status).toBe(404);
    expect((await get('/api/tracks/today', kiritimati, later)).status).toBe(404);
    expect(listDates((await get('/api/tracks', kiritimati, later)).body)).not.toContain(
      '2027-03-06',
    );
    // Offsets, zonas desconocidas y valores vacíos se rechazan en vez de caer a otra zona.
    for (const timezone of ['+14:00', 'Mars/Olympus', '', 'Etc/GMT-15']) {
      expect((await get('/api/tracks/today', { timezone }, later)).status).toBe(400);
    }
  });
});
