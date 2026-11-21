import { describe, expect, it, vi } from 'vitest';
import { createReplenishCatalogHandler } from '../../src/jobs/generate-daily-track-handler.ts';
import { notImplementedMusicSelector } from '../../src/music-selection/index.ts';
import { notImplementedSpotifyClient } from '../../src/spotify/index.ts';
import { getCatalogWindow } from '../../src/tracks/catalog.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { preparedTrack } from '../support/music.ts';

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
