import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogNoProgressError,
  createReplenishCatalogHandler,
  MIN_REMAINING_MS,
} from '../../src/jobs/generate-daily-track-handler.ts';
import { notImplementedMusicSelector } from '../../src/music-selection/index.ts';
import { notImplementedSpotifyClient } from '../../src/spotify/index.ts';
import { getCatalogWindow } from '../../src/tracks/catalog.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { preparedTrack } from '../support/music.ts';
import { createTimeWorld, expectOnlyCompleteTracks } from '../support/time-world.ts';

const NOW = new Date('2026-11-21T13:00:00Z');

const prepared = (date: string, n: number): DailyTrack => preparedTrack(date, n);

describe('handler de reposición del catálogo', () => {
  it('con el catálogo completo no consulta selección ni Spotify', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const repository = new InMemoryTrackRepository(
      getCatalogWindow(NOW).map((date, index) => prepared(date, index + 1)),
    );
    const handler = createReplenishCatalogHandler({
      repository,
      selector: notImplementedMusicSelector,
      spotify: notImplementedSpotifyClient,
      now: () => NOW,
    });

    await expect(handler()).resolves.toEqual({
      from: '2027-01-01',
      to: '2027-01-30',
      preparedBefore: 30,
      created: [],
      incomplete: [],
      deferred: [],
      budgetExhausted: false,
      stillMissing: [],
    });
    info.mockRestore();
  });

  it('falla de forma explícita mientras la selección no esté implementada', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handler = createReplenishCatalogHandler({
      repository: new InMemoryTrackRepository(),
      selector: notImplementedMusicSelector,
      spotify: notImplementedSpotifyClient,
      now: () => NOW,
    });

    await expect(handler()).rejects.toThrow(
      'Catalog replenishment stopped at 2027-01-01: Music selection is not implemented yet',
    );
    info.mockRestore();
  });
});

describe('handler de reposición con presupuesto de la Lambda', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const setup = (options: Parameters<typeof createTimeWorld>[0], remainingMs: number) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const world = createTimeWorld({ ...options, syncDate: true });
    const context = { getRemainingTimeInMillis: () => remainingMs - world.now() };
    return { world, context, handler: createReplenishCatalogHandler(world.dependencies) };
  };

  it('con menos tiempo que MIN_REMAINING_MS no empieza ninguna fecha ni llama a nadie', async () => {
    const { world, context, handler } = setup({}, MIN_REMAINING_MS);
    const output = await handler({}, context);
    expect(output.created).toEqual([]);
    expect(output.deferred).toHaveLength(30);
    expect(output.budgetExhausted).toBe(false);
    expect(world.fetchMock).not.toHaveBeenCalled();
  });

  it('sin ningún avance, agotar el presupuesto deja un evento de error y lanza un error propio', async () => {
    const { world, context, handler } = setup({ openaiMs: 40_000, found: () => false }, 110_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failure: unknown = await handler({}, context).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CatalogNoProgressError);
    expect((failure as Error).message).toBe(
      'Catalog replenishment made no progress: time budget exhausted with 30 date(s) deferred starting at 2027-01-01',
    );
    expect(world.countOf('openai')).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      event: 'catalog-replenish-no-progress',
      deferred: 30,
      firstDeferred: '2027-01-01',
    });
    expect(logged).not.toMatch(/Song \d|Artist \d/);
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });

  it('con al menos una fecha creada, agotar el presupuesto sigue siendo éxito', async () => {
    const { world, context, handler } = setup({ openaiMs: 30_000, found: (n) => n === 1 }, 140_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const output = await handler({}, context);
    expect(output.budgetExhausted).toBe(true);
    expect(output.created).toEqual(['2027-01-01']);
    expect(output.deferred).toHaveLength(29);
    expect(error).not.toHaveBeenCalled();
    // Nada de la fecha interrumpida: solo la creada, completa.
    expect(await expectOnlyCompleteTracks(world.repository)).toHaveLength(1);
  });

  it('agotar el tiempo por hasTimeLeft (sin cortar una fecha) no es falta de avance', async () => {
    const { handler, context } = setup({}, MIN_REMAINING_MS);
    await expect(handler({}, context)).resolves.toMatchObject({ budgetExhausted: false });
  });

  it('la cuota de OpenAI con Retry-After y presupuesto justo es un fallo, no presupuesto', async () => {
    const { world, context, handler } = setup(
      {
        openaiMs: 55_000,
        override: (kind) =>
          kind === 'openai'
            ? new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), {
                status: 429,
                headers: { 'retry-after': '5' },
              })
            : undefined,
      },
      MIN_REMAINING_MS + 1,
    );
    const failure: unknown = await handler({}, context).catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(CatalogNoProgressError);
    expect((failure as Error).message).toMatch(
      /^Catalog replenishment stopped at 2027-01-01: .*quota-exceeded/,
    );
    expect(world.countOf('openai')).toBe(1);
    expect(world.sleeps).toEqual([]);
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });

  it('el log no lleva títulos ni artistas', async () => {
    const { context, handler } = setup({ openaiMs: 5_000 }, 150_000);
    const info = vi.mocked(console.info);
    const output = await handler({}, context);
    const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('catalog-replenish');
    expect(logged).not.toMatch(/Song \d|Artist \d/);
    expect(output.created.length).toBeGreaterThan(0);
  });

  it('una cuota agotada hace que el handler lance, aunque haya presupuesto', async () => {
    const { world, context, handler } = setup(
      {
        override: (kind) =>
          kind === 'search'
            ? new Response(JSON.stringify({ reason: 'QUOTA_EXCEEDED' }), { status: 429 })
            : undefined,
      },
      300_000,
    );
    await expect(handler({}, context)).rejects.toThrow(
      /Catalog replenishment stopped at 2027-01-01/,
    );
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });

  it('un presupuesto agotado no se confunde con un fallo: la siguiente ejecución completa', async () => {
    const { world, handler } = setup({ openaiMs: 30_000 }, 0);
    const run = (remaining: number) =>
      handler({}, { getRemainingTimeInMillis: () => remaining - (world.now() - startedAt) });
    let startedAt = world.now();
    const first = await run(150_000);
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.created.length).toBeLessThan(30);
    startedAt = world.now();
    const second = await run(150_000);
    expect(second.created.length).toBeGreaterThan(0);
    await expectOnlyCompleteTracks(world.repository);
  });
});
