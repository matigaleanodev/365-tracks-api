import { describe, expect, it, vi } from 'vitest';
import { createReplenishCatalogHandler } from '../../src/jobs/generate-daily-track-handler.ts';
import type { MusicSelector } from '../../src/music-selection/index.ts';
import { getCatalogStatus, getCatalogWindow, replenishCatalog } from '../../src/tracks/catalog.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import {
  DESCRIPTION,
  fakeSpotify,
  ownArtist,
  preparedTrack,
  spotifyId,
  spotifyTrack,
} from '../support/music.ts';

const NOW = new Date('2026-11-21T13:00:00Z');

function deps(initial = [] as ReturnType<typeof preparedTrack>[]) {
  let calls = 0;
  const selector: MusicSelector = {
    select: vi.fn(() => {
      calls += 1;
      return Promise.resolve({
        spotifyTrackId: spotifyId(calls),
        selectionCriterion: 'hidden-gem',
        description: DESCRIPTION,
      });
    }),
  };
  const spotify = fakeSpotify({
    getTrack: (id) => Promise.resolve(spotifyTrack(id, { title: `Song ${id}`, ...ownArtist(id) })),
  });
  const repository = new InMemoryTrackRepository(initial);
  return { repository, selector, spotify, now: () => NOW };
}

describe('reposición acotada y reanudable', () => {
  it('maxNew limita las fechas nuevas y difiere el resto sin tratarlo como error', async () => {
    const d = deps();
    const report = await replenishCatalog(d, undefined, { maxNew: 5 });

    expect(report.created).toHaveLength(5);
    expect(report.deferred).toHaveLength(25);
    expect(report.outcomes.filter((o) => o.status === 'failed')).toEqual([]);
    expect(d.selector.select).toHaveBeenCalledTimes(5);
  });

  it('procesa las fechas más próximas primero', async () => {
    const d = deps();
    const report = await replenishCatalog(d, undefined, { maxNew: 3 });
    expect(report.created).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('se reanuda: ejecuciones sucesivas completan las 30 fechas sin repetir ni pisar', async () => {
    const d = deps();
    let runs = 0;
    for (; runs < 10; runs += 1) {
      const report = await replenishCatalog(d, undefined, { maxNew: 5 });
      if (report.stillMissing.length === 0) break;
    }
    expect(runs).toBe(5); // 6 ejecuciones: 5+5+5+5+5+5
    const status = await getCatalogStatus(d.repository, getCatalogWindow(NOW));
    expect(status.prepared).toHaveLength(30);
    expect(d.selector.select).toHaveBeenCalledTimes(30);
  });

  it('hasTimeLeft corta antes de empezar una fecha nueva', async () => {
    const d = deps();
    let remaining = 2;
    const report = await replenishCatalog(d, undefined, {
      hasTimeLeft: () => remaining-- > 0,
    });
    expect(report.created).toHaveLength(2);
    expect(report.deferred).toHaveLength(28);
  });

  it('una canción incompleta existente se informa y no se pisa ni se cuenta como preparada', async () => {
    const broken = preparedTrack('2027-01-02', 99, { description: undefined });
    const d = deps([broken]);
    const report = await replenishCatalog(d, getCatalogWindow(NOW, 4));

    expect(report.incomplete).toEqual(['2027-01-02']);
    expect(report.preparedBefore).toBe(0);
    expect(report.created).toEqual(['2027-01-01', '2027-01-03', '2027-01-04']);
    expect(await d.repository.getByDate('2027-01-02')).toEqual(broken);
  });

  it('la selección falla de forma explícita: no se guarda nada y la fecha queda libre', async () => {
    const d = deps();
    d.selector.select = vi.fn(() => Promise.reject(new Error('no valid song')));
    const report = await replenishCatalog(d, getCatalogWindow(NOW, 3));
    expect(report.created).toEqual([]);
    expect(report.stillMissing).toHaveLength(3);
    expect(await d.repository.getByDate('2027-01-01')).toBeNull();
  });
});

describe('handler con presupuesto', () => {
  const quiet = () => vi.spyOn(console, 'info').mockImplementation(() => undefined);

  it('aplica el tope por ejecución y lo informa como diferido', async () => {
    const info = quiet();
    const handler = createReplenishCatalogHandler(deps(), { maxNew: 2 });
    const output = await handler();
    expect(output.created).toHaveLength(2);
    expect(output.deferred).toHaveLength(28);
    info.mockRestore();
  });

  it('corta cuando queda poco tiempo en la Lambda', async () => {
    const info = quiet();
    const handler = createReplenishCatalogHandler(deps(), { maxNew: 10 });
    const output = await handler({}, { getRemainingTimeInMillis: () => 10_000 });
    expect(output.created).toEqual([]);
    expect(output.deferred).toHaveLength(30);
    info.mockRestore();
  });

  it('el log no incluye títulos ni artistas, solo fechas y conteos', async () => {
    const info = quiet();
    const handler = createReplenishCatalogHandler(deps(), { maxNew: 2 });
    await handler();
    const logged = info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toMatch(/Song |Artist/);
    expect(logged).toContain('catalog-replenish');
    info.mockRestore();
  });

  it('un fallo informa el avance y termina con error para que el Scheduler reintente', async () => {
    const info = quiet();
    const d = deps();
    d.selector.select = vi
      .fn()
      .mockResolvedValueOnce({
        spotifyTrackId: spotifyId(1),
        selectionCriterion: 'classic',
        description: DESCRIPTION,
      })
      .mockRejectedValue(new Error('openai quota'));
    const handler = createReplenishCatalogHandler(d);
    await expect(handler()).rejects.toThrow(
      'Catalog replenishment stopped at 2027-01-02: openai quota',
    );
    expect(await d.repository.getByDate('2027-01-01')).not.toBeNull();
    info.mockRestore();
  });
});
