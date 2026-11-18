import { describe, expect, it, vi } from 'vitest';
import type { MusicSelector } from '../../src/music-selection/index.ts';
import type { SpotifyClient } from '../../src/spotify/index.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { generateDailyTrack } from '../../src/tracks/generate-daily-track.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';

const NOW = new Date('2027-01-01T00:05:00Z');

function setup(initial: DailyTrack[] = []) {
  const repository = new InMemoryTrackRepository(initial);
  const selector: MusicSelector = {
    select: vi.fn().mockResolvedValue({
      spotifyTrackId: 'abc',
      selectionCriterion: 'test-criterion',
      description: 'A description',
    }),
  };
  const spotify: SpotifyClient = {
    getTrack: vi.fn().mockResolvedValue({
      id: 'abc',
      title: 'Title',
      artist: 'Artist',
      album: 'Album',
      releaseYear: 1999,
      url: 'https://open.spotify.com/track/abc',
    }),
  };
  return {
    repository,
    selector,
    spotify,
    dependencies: { repository, selector, spotify, now: () => NOW },
  };
}

describe('generateDailyTrack', () => {
  it('crea la canción del día con los campos obligatorios y los opcionales presentes', async () => {
    const { dependencies, repository } = setup();

    const result = await generateDailyTrack(dependencies, '2027-01-01');

    expect(result.status).toBe('created');
    expect(result.track).toEqual({
      date: '2027-01-01',
      title: 'Title',
      artist: 'Artist',
      album: 'Album',
      releaseYear: 1999,
      spotifyTrackId: 'abc',
      spotifyUrl: 'https://open.spotify.com/track/abc',
      selectionCriterion: 'test-criterion',
      description: 'A description',
      createdAt: '2027-01-01T00:05:00.000Z',
    });
    expect(await repository.getByDate('2027-01-01')).toEqual(result.track);
  });

  it('es idempotente: la segunda ejecución no vuelve a seleccionar ni a consultar Spotify', async () => {
    const { dependencies, selector, spotify } = setup();

    const first = await generateDailyTrack(dependencies, '2027-01-01');
    const second = await generateDailyTrack(dependencies, '2027-01-01');

    expect(second.status).toBe('already-exists');
    expect(second.track).toEqual(first.track);
    expect(selector.select).toHaveBeenCalledTimes(1);
    expect(spotify.getTrack).toHaveBeenCalledTimes(1);
  });

  it('ejecuciones concurrentes dejan una sola canción por fecha', async () => {
    const { dependencies, repository } = setup();

    const results = await Promise.all([
      generateDailyTrack(dependencies, '2027-01-01'),
      generateDailyTrack(dependencies, '2027-01-01'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['already-exists', 'created']);
    expect(results[0]?.track).toEqual(results[1]?.track);
    expect((await repository.list({ limit: 10 })).items).toHaveLength(1);
  });
});
