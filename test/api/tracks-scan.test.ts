import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../../src/api/app.ts';
import type { TrackListResponse } from '../../src/api/contracts.ts';
import { decodeCursor } from '../../src/api/pagination.ts';
import { addDays, getLocalDate } from '../../src/shared/dates.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { PUBLICATION_START_DATE } from '../../src/tracks/publication.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { preparedTrack } from '../support/music.ts';

const context = { getRemainingTimeInMillis: () => 30_000 } as unknown as Context;
/** Debe coincidir con MAX_SCAN_PAGES de src/api/routes.ts (no se exporta). */
const MAX_SCAN_PAGES = 10;

const NOW = new Date('2028-06-15T12:00:00Z');
const TODAY_UTC = '2028-06-15';
const INCOMPLETE_RUN = 501;

const incomplete = (date: string, n: number) =>
  ({ ...preparedTrack(date, n), description: undefined }) as unknown as DailyTrack;

/** 501 incompletas consecutivas (las fechas más nuevas hasta hoy UTC), completas antes y futuras después. */
function buildCatalog() {
  const tracks: DailyTrack[] = [];
  const completeDates: string[] = [];
  let n = 1;
  for (let offset = 0; offset < INCOMPLETE_RUN; offset += 1) {
    tracks.push(incomplete(addDays(TODAY_UTC, -offset), n++));
  }
  for (let offset = INCOMPLETE_RUN; offset < INCOMPLETE_RUN + 65; offset += 1) {
    const date = addDays(TODAY_UTC, -offset);
    tracks.push(preparedTrack(date, n++));
    // Las anteriores al lanzamiento existen pero la API nunca las expone.
    if (date >= PUBLICATION_START_DATE) completeDates.push(date);
  }
  // Futuras completas: nunca deben verse ni asomar en un cursor.
  const futureDates = [1, 2, 3].map((offset) => addDays(TODAY_UTC, offset));
  for (const date of futureDates) tracks.push(preparedTrack(date, n++));
  return { tracks, completeDates, futureDates };
}

function setup(tracks: DailyTrack[]) {
  const inner = new InMemoryTrackRepository(tracks);
  const list = vi.fn(inner.list.bind(inner));
  const repository = Object.assign(Object.create(inner) as InMemoryTrackRepository, { list });
  const handler = createApiHandler({ repository, now: () => NOW });
  const request = async (query: Record<string, string>) => {
    list.mockClear();
    const event = {
      version: '2.0',
      rawPath: '/api/tracks',
      queryStringParameters: query,
      requestContext: { requestId: 'r', http: { method: 'GET', path: '/api/tracks' } },
    } as unknown as APIGatewayProxyEventV2;
    const response = (await handler(event, context)) as APIGatewayProxyStructuredResultV2;
    expect(response.statusCode).toBe(200);
    return {
      body: JSON.parse(response.body as string) as TrackListResponse,
      reads: list.mock.calls.length,
    };
  };
  return { request };
}

/** Recorre todo el historial; devuelve fechas entregadas, cursores y cantidad de pedidos. */
async function walk(request: ReturnType<typeof setup>['request'], query: Record<string, string>) {
  const dates: string[] = [];
  const cursors: string[] = [];
  let requests = 0;
  let cursor: string | undefined;
  for (;;) {
    requests += 1;
    expect(requests).toBeLessThan(100); // acotado: sin bucle infinito
    const { body, reads } = await request({ ...query, ...(cursor ? { cursor } : {}) });
    expect(reads).toBeLessThanOrEqual(MAX_SCAN_PAGES);
    expect(Object.keys(body)).toEqual(['data', 'pagination']);
    expect(Object.keys(body.pagination).sort()).toEqual(['limit', 'nextCursor']);
    expect(body.pagination.limit).toBe(Number(query.limit ?? 30));
    expect(body.data.length).toBeLessThanOrEqual(body.pagination.limit);
    dates.push(...body.data.map((item) => item.date));
    const next = body.pagination.nextCursor;
    if (next === null) break;
    expect(next).not.toBe(cursor);
    const decoded = decodeCursor(next);
    expect(decoded).not.toBeNull();
    if (cursors.length > 0) {
      // Avanza estrictamente hacia fechas anteriores.
      expect((decoded as string) < (decodeCursor(cursors.at(-1) as string) as string)).toBe(true);
    }
    cursors.push(next);
    cursor = next;
  }
  return { dates, cursors, requests };
}

describe('GET /api/tracks con una racha larga de incompletas', () => {
  it.each([30, 100, 7])(
    'con limit=%i el cursor avanza, no repite y devuelve todas las completas en orden',
    async (limit) => {
      const { tracks, completeDates } = buildCatalog();
      const { request } = setup(tracks);

      const { dates, requests } = await walk(request, { limit: String(limit) });

      expect(dates).toEqual(completeDates);
      expect(new Set(dates).size).toBe(dates.length);
      expect(requests).toBeGreaterThanOrEqual(2); // 501 > 10 lecturas de 50
    },
  );

  it('una página puede salir vacía con cursor, pero solo mientras haya algo por recorrer', async () => {
    const { tracks } = buildCatalog();
    const { request } = setup(tracks);
    const first = await request({});
    expect(first.reads).toBe(MAX_SCAN_PAGES);
    expect(first.body.data).toEqual([]);
    expect(first.body.pagination.nextCursor).toEqual(expect.any(String));
  });

  it('nunca expone fechas futuras, ni en datos ni en cursores, según la zona', async () => {
    const { tracks, futureDates } = buildCatalog();
    for (const [timeZone, expectedFuture] of [
      ['America/Los_Angeles', []],
      ['UTC', []],
      ['Pacific/Kiritimati', [futureDates[0]]],
    ] as const) {
      const { request } = setup(tracks);
      const localToday = getLocalDate(NOW, timeZone);
      const { dates, cursors } = await walk(request, { limit: '30', timezone: timeZone });
      expect(dates.filter((date) => date > localToday)).toEqual([]);
      for (const cursor of cursors) {
        expect((decodeCursor(cursor) as string) <= localToday).toBe(true);
      }
      expect(dates.filter((date) => futureDates.includes(date))).toEqual(expectedFuture);
      // Con zona mucho más adelantada, la primera completa visible es la de "mañana" UTC.
      if (timeZone === 'Pacific/Kiritimati') expect(dates[0]).toBe(futureDates[0]);
    }
  });

  it('un cursor mayor que el límite local se recorta: no revela fechas futuras', async () => {
    const { tracks, futureDates } = buildCatalog();
    const { request } = setup(tracks);
    const cursor = Buffer.from(futureDates[2] as string).toString('base64url');
    const { body } = await request({ cursor, timezone: 'America/Los_Angeles', limit: '100' });
    expect(body.data.every((item) => item.date <= getLocalDate(NOW, 'America/Los_Angeles'))).toBe(
      true,
    );
  });
});
