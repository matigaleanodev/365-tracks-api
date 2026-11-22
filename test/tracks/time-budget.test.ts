import { describe, expect, it, vi } from 'vitest';
import type { MusicSelector } from '../../src/music-selection/index.ts';
import { TimeBudgetExhaustedError } from '../../src/shared/time-budget.ts';
import { getCatalogWindow, replenishCatalog } from '../../src/tracks/catalog.ts';
import { generateDailyTrack, PERSIST_COST_MS } from '../../src/tracks/generate-daily-track.ts';
import { createTimeBudget } from '../../src/shared/time-budget.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { DESCRIPTION, fakeSpotify, spotifyId, spotifyTrack } from '../support/music.ts';
import { createTimeWorld, expectOnlyCompleteTracks } from '../support/time-world.ts';

const NOW = new Date('2026-11-21T13:00:00Z');
const quota = () => new Response(JSON.stringify({ reason: 'QUOTA_EXCEEDED' }), { status: 429 });

describe('presupuesto de tiempo en la reposición', () => {
  it('con poco tiempo antes de empezar una canción, queda diferida y no hay ninguna llamada HTTP', async () => {
    const world = createTimeWorld({ openaiMs: 30_000 });
    // 60 s menos 20 s de reserva = 40 s: un intento de OpenAI (45 s) no entra.
    const report = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 3), {
      budget: world.budget(60_000),
    });

    expect(report.budgetExhausted).toBe(true);
    expect(report.created).toEqual([]);
    expect(report.deferred).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
    expect(report.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(world.fetchMock).not.toHaveBeenCalled();
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });

  it('si OpenAI consume gran parte del presupuesto, el siguiente intento no arranca y no se escribe', async () => {
    // Cada propuesta tarda 40 s y Spotify no encuentra nada, así que hacen falta más rondas.
    const world = createTimeWorld({ openaiMs: 40_000, found: () => false });
    const budget = world.budget(110_000); // útil: 90 s
    const report = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 2), {
      budget,
    });

    // Ronda 1 (t=0) y ronda 2 (t=40) entran; la 3 (t=80, quedan 10 s útiles) no.
    expect(world.countOf('openai')).toBe(2);
    expect(world.countOf('search')).toBe(4); // dos búsquedas (campo y texto libre) por candidato
    expect(world.countOf('token')).toBe(1);
    expect(world.fetchMock).toHaveBeenCalledTimes(7);
    expect(report.budgetExhausted).toBe(true);
    expect(report.deferred).toEqual(['2027-01-01', '2027-01-02']);
    expect(report.created).toEqual([]);
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);

    // Ninguna llamada empezó sin que su timeout entrara antes de la reserva.
    const timeouts = { openai: 45_000, token: 10_000, search: 10_000, track: 10_000 };
    for (const { kind, startedAt } of world.calls) {
      expect(startedAt + timeouts[kind]).toBeLessThanOrEqual(110_000 - 20_000);
    }
  });

  it('cero llamadas después de agotar el presupuesto: reintentar con el mismo presupuesto no envía nada', async () => {
    const world = createTimeWorld({ openaiMs: 40_000, found: () => false });
    const budget = world.budget(110_000);
    await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 2), { budget });
    const before = world.fetchMock.mock.calls.length;

    const again = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 2), { budget });
    expect(again.budgetExhausted).toBe(true);
    expect(world.fetchMock.mock.calls.length).toBe(before);
    expect(world.sleeps).toEqual([]);
  });

  it('una ejecución con fechas diferidas se completa en una segunda con presupuesto nuevo', async () => {
    const world = createTimeWorld({ openaiMs: 30_000 });
    const window = getCatalogWindow(NOW, 4);

    // Útil 80 s: caben dos fechas de 30 s; la tercera (t=60) no entra (45 s > 20 s).
    const first = await replenishCatalog(world.dependencies, window, {
      budget: world.budget(100_000),
    });
    expect(first.created).toEqual(['2027-01-01', '2027-01-02']);
    expect(first.deferred).toEqual(['2027-01-03', '2027-01-04']);
    expect(first.budgetExhausted).toBe(true);
    expect(first.stillMissing).toEqual(['2027-01-03', '2027-01-04']);
    expect(await expectOnlyCompleteTracks(world.repository)).toHaveLength(2);

    const second = await replenishCatalog(world.dependencies, window, {
      budget: world.budget(100_000),
    });
    expect(second.created).toEqual(['2027-01-03', '2027-01-04']);
    expect(second.deferred).toEqual([]);
    expect(second.budgetExhausted).toBe(false);
    expect(second.stillMissing).toEqual([]);
    expect(await expectOnlyCompleteTracks(world.repository)).toHaveLength(4);
  });

  it('una cuota agotada (QUOTA_EXCEEDED) es un fallo, no presupuesto', async () => {
    const world = createTimeWorld({
      override: (kind) => (kind === 'search' ? quota() : undefined),
    });
    const report = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 3), {
      budget: world.budget(250_000),
    });

    expect(report.budgetExhausted).toBe(false);
    expect(report.outcomes[0]).toMatchObject({ date: '2027-01-01', status: 'failed' });
    expect(report.outcomes.map((o) => o.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(report.deferred).toEqual([]);
    expect(world.countOf('search')).toBe(1);
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });

  it('sin presupuesto el comportamiento anterior se conserva', async () => {
    const world = createTimeWorld({ openaiMs: 400_000 });
    const report = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 2));
    expect(report.created).toHaveLength(2);
    expect(report.budgetExhausted).toBe(false);
  });
});

describe('presupuesto de tiempo dentro de una fecha', () => {
  it('si vence entre dos candidatos no se busca el segundo', async () => {
    let clock = 0;
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 20_000, now: () => clock });
    const propose = vi.fn(() =>
      Promise.resolve([
        { title: 'Song 1', artist: 'Artist 1', releaseYear: 1990, description: DESCRIPTION },
        { title: 'Song 2', artist: 'Artist 2', releaseYear: 1990, description: DESCRIPTION },
      ]),
    );
    const searchTracks = vi.fn(() => {
      clock = 85_000; // la primera búsqueda deja al presupuesto dentro de la reserva
      return Promise.resolve([]);
    });
    const { createEditorialSelector } = await import('../../src/music-selection/selector.ts');
    const selector = createEditorialSelector({
      proposer: { propose },
      spotify: fakeSpotify({ searchTracks }),
      repository: new InMemoryTrackRepository(),
    });

    await expect(selector.select('2027-03-15', { budget })).rejects.toBeInstanceOf(
      TimeBudgetExhaustedError,
    );
    expect(searchTracks).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it('si vence entre la selección y la persistencia no se llama a repository.create', async () => {
    let clock = 0;
    // Útil hasta el límite duro: 100 s. Tras seleccionar quedan menos de PERSIST_COST_MS.
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 20_000, now: () => clock });
    const repository = new InMemoryTrackRepository();
    const create = vi.spyOn(repository, 'create');
    const selector: MusicSelector = {
      select: vi.fn(() => {
        clock = 100_000 - PERSIST_COST_MS + 1;
        return Promise.resolve({
          spotifyTrackId: spotifyId(1),
          selectionCriterion: 'hidden-gem',
          description: DESCRIPTION,
        });
      }),
    };
    const spotify = fakeSpotify({
      getTrack: (id) => Promise.resolve(spotifyTrack(id)),
    });

    await expect(
      generateDailyTrack({ repository, selector, spotify, now: () => NOW }, '2027-01-01', {
        budget,
      }),
    ).rejects.toBeInstanceOf(TimeBudgetExhaustedError);
    expect(create).not.toHaveBeenCalled();
    expect(await expectOnlyCompleteTracks(repository)).toEqual([]);
  });

  it('con tiempo justo para persistir (dentro de la reserva) sí escribe', async () => {
    let clock = 0;
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 20_000, now: () => clock });
    const repository = new InMemoryTrackRepository();
    const selector: MusicSelector = {
      select: () => {
        clock = 100_000 - PERSIST_COST_MS;
        return Promise.resolve({
          spotifyTrackId: spotifyId(1),
          selectionCriterion: 'hidden-gem',
          description: DESCRIPTION,
        });
      },
    };
    const spotify = fakeSpotify({ getTrack: (id) => Promise.resolve(spotifyTrack(id)) });
    await expect(
      generateDailyTrack({ repository, selector, spotify, now: () => NOW }, '2027-01-01', {
        budget,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    expect(await expectOnlyCompleteTracks(repository)).toHaveLength(1);
  });

  it('Spotify con varios 429 y Retry-After: se respeta mientras entra y corta sin dormir cuando no entra', async () => {
    const world = createTimeWorld({
      spotifyMs: 10_000,
      override: (kind) =>
        kind === 'search'
          ? new Response('{}', { status: 429, headers: { 'retry-after': '15' } })
          : undefined,
    });
    // Límite t=100, reserva 20: tras el token (0-10) y OpenAI, las búsquedas empiezan en t=10,
    // 35 y 60; después de la tercera (t=70) esperar 15 s y reintentar (10 s) pasa de t=80.
    const report = await replenishCatalog(world.dependencies, getCatalogWindow(NOW, 2), {
      budget: world.budget(100_000),
    });

    expect(world.countOf('search')).toBe(3);
    expect(world.sleeps).toEqual([15_000, 15_000]);
    expect(report.budgetExhausted).toBe(true);
    expect(report.deferred).toEqual(['2027-01-01', '2027-01-02']);
    expect(report.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(await expectOnlyCompleteTracks(world.repository)).toEqual([]);
  });
});
