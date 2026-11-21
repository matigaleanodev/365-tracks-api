import { describe, expect, it, vi } from 'vitest';
import type { MusicSelector } from '../../src/music-selection/index.ts';
import { NotImplementedError } from '../../src/shared/errors.ts';
import type { SpotifyClient } from '../../src/spotify/index.ts';
import {
  CATALOG_WINDOW_DAYS,
  getCatalogStatus,
  getCatalogWindow,
  replenishCatalog,
} from '../../src/tracks/catalog.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { DESCRIPTION, fakeSpotify, preparedTrack, spotifyTrack } from '../support/music.ts';

const PRE_LAUNCH = new Date('2026-11-21T13:00:00Z');

const id = (n: number) => `track${String(n).padStart(17, '0')}`;

function stored(date: string, n: number): DailyTrack {
  return preparedTrack(date, n);
}

/** Selector determinista: la N-ésima llamada elige la canción N. */
function fakes(now: Date) {
  let calls = 0;
  const selector: MusicSelector = {
    select: vi.fn(() => {
      calls += 1;
      return Promise.resolve({
        spotifyTrackId: id(calls),
        selectionCriterion: 'auto',
        description: DESCRIPTION,
      });
    }),
  };
  const spotify: SpotifyClient = fakeSpotify({
    getTrack: vi.fn((trackId: string) => Promise.resolve(spotifyTrack(trackId))),
  });
  const repository = new InMemoryTrackRepository();
  return { repository, selector, spotify, now: () => now };
}

describe('getCatalogWindow', () => {
  it('antes del lanzamiento cubre del 1 al 30 de enero de 2027', () => {
    const window = getCatalogWindow(PRE_LAUNCH);
    expect(window).toHaveLength(CATALOG_WINDOW_DAYS);
    expect(window[0]).toBe('2027-01-01');
    expect(window.at(-1)).toBe('2027-01-30');
  });

  it('es una ventana móvil que arranca en la fecha UTC de ayer una vez lanzado', () => {
    const window = getCatalogWindow(new Date('2027-02-10T08:00:00Z'));
    expect(window[0]).toBe('2027-02-09');
    expect(window.at(-1)).toBe('2027-03-10');
  });

  it('el día del lanzamiento no incluye fechas previas al 2027-01-01', () => {
    expect(getCatalogWindow(new Date('2027-01-01T00:00:00Z'))[0]).toBe('2027-01-01');
  });

  it('cubre a la zona más adelantada (UTC+14) y a la más atrasada (UTC-12)', () => {
    const now = new Date('2027-05-20T23:59:59Z');
    const window = getCatalogWindow(now);
    expect(window).toContain('2027-05-19'); // todavía "hoy" en UTC-12
    expect(window).toContain('2027-05-21'); // ya "hoy" en UTC+14
    // Margen de reserva sobre la zona líder: al menos 27 días.
    expect(
      window.indexOf(window.at(-1) as string) - window.indexOf('2027-05-21'),
    ).toBeGreaterThanOrEqual(27);
  });

  it('acepta un tamaño de ventana distinto', () => {
    expect(getCatalogWindow(PRE_LAUNCH, 7)).toHaveLength(7);
  });
});

describe('getCatalogStatus', () => {
  it('informa fechas preparadas y faltantes', async () => {
    const repository = new InMemoryTrackRepository([
      stored('2027-01-01', 1),
      stored('2027-01-03', 2),
    ]);
    const status = await getCatalogStatus(repository, getCatalogWindow(PRE_LAUNCH, 5));
    expect(status).toEqual({
      from: '2027-01-01',
      to: '2027-01-05',
      prepared: ['2027-01-01', '2027-01-03'],
      incomplete: [],
      missing: ['2027-01-02', '2027-01-04', '2027-01-05'],
    });
  });

  it('un catálogo vacío tiene las 30 fechas faltantes', async () => {
    const status = await getCatalogStatus(
      new InMemoryTrackRepository(),
      getCatalogWindow(PRE_LAUNCH),
    );
    expect(status.prepared).toEqual([]);
    expect(status.missing).toHaveLength(30);
  });

  it('solo usa lecturas por fecha (el rol del job no tiene Query)', async () => {
    const getByDate = vi.fn(() => Promise.resolve(null));
    await getCatalogStatus({ getByDate }, ['2027-01-01', '2027-01-02']);
    expect(getByDate).toHaveBeenCalledTimes(2);
  });
});

describe('replenishCatalog', () => {
  it('prepara las 30 fechas del primer mes cuando el catálogo está vacío', async () => {
    const deps = fakes(PRE_LAUNCH);
    const report = await replenishCatalog(deps);
    expect(report.created).toHaveLength(30);
    expect(report.stillMissing).toEqual([]);
    expect(report.preparedBefore).toBe(0);
    const status = await getCatalogStatus(deps.repository, getCatalogWindow(PRE_LAUNCH));
    expect(status.missing).toEqual([]);
    expect((await deps.repository.getByDate('2027-01-30'))?.selectionCriterion).toBe('auto');
  });

  it('procesa únicamente las fechas faltantes y no modifica las existentes', async () => {
    const deps = fakes(PRE_LAUNCH);
    const manual = [stored('2027-01-01', 101), stored('2027-01-15', 102)];
    for (const track of manual) await deps.repository.create(track);

    const report = await replenishCatalog(deps);

    expect(report.preparedBefore).toBe(2);
    expect(report.created).toHaveLength(28);
    expect(report.created).not.toContain('2027-01-01');
    expect(deps.selector.select).toHaveBeenCalledTimes(28);
    expect(await deps.repository.getByDate('2027-01-01')).toEqual(manual[0]);
    expect(await deps.repository.getByDate('2027-01-15')).toEqual(manual[1]);
  });

  it('es idempotente: una segunda ejecución no hace nada', async () => {
    const deps = fakes(PRE_LAUNCH);
    await replenishCatalog(deps);
    const second = await replenishCatalog(deps);
    expect(second.created).toEqual([]);
    expect(second.outcomes).toEqual([]);
    expect(deps.selector.select).toHaveBeenCalledTimes(30);
  });

  it('con la ventana móvil repone solo el día nuevo', async () => {
    const deps = fakes(PRE_LAUNCH);
    await replenishCatalog(deps);
    const next = { ...deps, now: () => new Date('2027-01-02T12:00:00Z') };
    const report = await replenishCatalog(next);
    // Ventana: 2027-01-01 → 2027-01-30 (ayer = 01-01). Sin faltantes; sigue completa.
    expect(report.created).toEqual([]);
    const later = { ...deps, now: () => new Date('2027-01-05T12:00:00Z') };
    const grown = await replenishCatalog(later);
    // Ventana: 2027-01-04 → 2027-02-02: faltan 01-31, 02-01 y 02-02.
    expect(grown.created).toEqual(['2027-01-31', '2027-02-01', '2027-02-02']);
  });

  it('se detiene en el primer fallo, informa el resto como omitido y permite reintentar', async () => {
    const deps = fakes(PRE_LAUNCH);
    const failing: MusicSelector = {
      select: vi
        .fn()
        .mockResolvedValueOnce({
          spotifyTrackId: id(1),
          selectionCriterion: 'auto',
          description: DESCRIPTION,
        })
        .mockResolvedValueOnce({
          spotifyTrackId: id(2),
          selectionCriterion: 'auto',
          description: DESCRIPTION,
        })
        .mockRejectedValueOnce(new Error('spotify rate limit'))
        .mockImplementation(() => Promise.reject(new Error('should not be called'))),
    };
    const report = await replenishCatalog({ ...deps, selector: failing });

    expect(report.created).toEqual(['2027-01-01', '2027-01-02']);
    expect(report.outcomes[2]).toEqual({
      date: '2027-01-03',
      status: 'failed',
      error: 'spotify rate limit',
    });
    expect(report.outcomes[3]).toEqual({ date: '2027-01-04', status: 'skipped' });
    expect(report.stillMissing).toHaveLength(28);
    expect(failing.select).toHaveBeenCalledTimes(3);

    const retry = await replenishCatalog(deps);
    expect(retry.preparedBefore).toBe(2);
    expect(retry.created).toHaveLength(28);
    expect((await deps.repository.getByDate('2027-01-01'))?.title).toBe(`Song ${id(1)}`);
  });

  it('con la selección sin implementar informa el fallo y no escribe nada', async () => {
    const deps = fakes(PRE_LAUNCH);
    const selector: MusicSelector = {
      select: () => Promise.reject(new NotImplementedError('Music selection')),
    };
    const report = await replenishCatalog({ ...deps, selector });
    expect(report.created).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(report.stillMissing).toHaveLength(30);
    expect((await deps.repository.list({ limit: 100 })).items).toEqual([]);
  });

  it('no escribe una canción incompleta y la fecha queda libre', async () => {
    const deps = fakes(PRE_LAUNCH);
    const spotify: SpotifyClient = fakeSpotify({
      getTrack: vi.fn().mockResolvedValue(spotifyTrack(id(1), { title: '  ' })),
    });
    const report = await replenishCatalog({ ...deps, spotify }, getCatalogWindow(PRE_LAUNCH, 3));
    expect(report.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(report.outcomes[0]).toMatchObject({ error: expect.stringContaining('title') });
    expect(await deps.repository.getByDate('2027-01-01')).toBeNull();
  });

  it('ejecuciones concurrentes no duplican ni pisan fechas', async () => {
    const deps = fakes(PRE_LAUNCH);
    const [a, b] = await Promise.all([replenishCatalog(deps), replenishCatalog(deps)]);
    const items = (await deps.repository.list({ limit: 100 })).items;
    expect(items).toHaveLength(30);
    expect(new Set(items.map((item) => item.date)).size).toBe(30);
    // Cada fecha la crea exactamente una de las dos ejecuciones.
    expect(a.created.length + b.created.length).toBe(30);
    expect(a.created.filter((date) => b.created.includes(date))).toEqual([]);
  });

  it('una canción preparada a mano mientras corre el proceso no se sobrescribe', async () => {
    const deps = fakes(PRE_LAUNCH);
    const manual = stored('2027-01-02', 999);
    const racing: TrackRepository = {
      getByDate: deps.repository.getByDate.bind(deps.repository),
      list: deps.repository.list.bind(deps.repository),
      create: async (track) => {
        if (track.date === '2027-01-02') await deps.repository.create(manual);
        return deps.repository.create(track);
      },
    };
    const report = await replenishCatalog(
      { ...deps, repository: racing },
      getCatalogWindow(PRE_LAUNCH, 3),
    );
    expect(report.outcomes[1]).toEqual({ date: '2027-01-02', status: 'already-exists' });
    expect(await deps.repository.getByDate('2027-01-02')).toEqual(manual);
  });
});
