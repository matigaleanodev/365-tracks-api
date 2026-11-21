import { describe, expect, it, vi } from 'vitest';
import { createGenerateDailyTrackHandler } from '../../src/jobs/generate-daily-track-handler.ts';
import { notImplementedMusicSelector } from '../../src/music-selection/index.ts';
import { notImplementedSpotifyClient } from '../../src/spotify/index.ts';
import { buildDevFixtures } from '../../src/tracks/dev-fixtures.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';

const NOW = new Date('2027-01-01T00:05:00Z');

describe('handler del proceso diario', () => {
  it('usa la fecha editorial UTC y no vuelve a generar si ya existe', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const handler = createGenerateDailyTrackHandler({
      repository: new InMemoryTrackRepository(buildDevFixtures(NOW, 1)),
      selector: notImplementedMusicSelector,
      spotify: notImplementedSpotifyClient,
      now: () => NOW,
    });

    await expect(handler()).resolves.toEqual({ date: '2027-01-01', status: 'already-exists' });
    info.mockRestore();
  });

  it('falla de forma explícita mientras la selección no esté implementada', async () => {
    const handler = createGenerateDailyTrackHandler({
      repository: new InMemoryTrackRepository(),
      selector: notImplementedMusicSelector,
      spotify: notImplementedSpotifyClient,
      now: () => NOW,
    });

    await expect(handler()).rejects.toThrow('Music selection is not implemented yet');
  });
});
