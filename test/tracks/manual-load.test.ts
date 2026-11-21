import { describe, expect, it, vi } from 'vitest';
import { loadTrackManually } from '../../src/tracks/manual-load.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import { DESCRIPTION } from '../support/music.ts';

const NOW = new Date('2026-11-21T13:00:00Z');

const input = (overrides: Record<string, unknown> = {}) => ({
  date: '2027-01-01',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  releaseYear: 1991,
  spotifyTrackId: '4uLU6hMCjMI75M1A2tKUQC',
  spotifyUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  selectionCriterion: 'manual',
  description: DESCRIPTION,
  ...overrides,
});

describe('loadTrackManually', () => {
  it('sin repositorio solo valida y no escribe', async () => {
    const result = await loadTrackManually({ raw: input(), now: NOW });
    expect(result.status).toBe('valid');
  });

  it('con datos inválidos no toca el repositorio', async () => {
    const create = vi.fn();
    const repository = { create } as unknown as TrackRepository;
    const result = await loadTrackManually({ raw: input({ date: 'x' }), now: NOW, repository });
    expect(result.status).toBe('invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('rechaza el criterio deshabilitado como etiqueta nueva', async () => {
    const result = await loadTrackManually({
      raw: input({ selectionCriterion: 'music-anniversary' }),
      now: NOW,
    });
    expect(result.status).toBe('invalid');
  });

  it('crea la canción y queda disponible por fecha', async () => {
    const repository = new InMemoryTrackRepository();
    const result = await loadTrackManually({ raw: input(), now: NOW, repository });
    expect(result.status).toBe('created');
    expect(await repository.getByDate('2027-01-01')).toMatchObject({ title: 'Song' });
  });

  it('no sobrescribe una fecha existente y devuelve el registro vigente', async () => {
    const repository = new InMemoryTrackRepository();
    await loadTrackManually({ raw: input(), now: NOW, repository });
    const result = await loadTrackManually({
      raw: input({ title: 'Other song' }),
      now: NOW,
      repository,
    });
    expect(result.status).toBe('already-exists');
    expect(result.status === 'already-exists' && result.track.title).toBe('Song');
    expect((await repository.getByDate('2027-01-01'))?.title).toBe('Song');
  });

  it('dos fechas distintas conviven', async () => {
    const repository = new InMemoryTrackRepository();
    await loadTrackManually({ raw: input(), now: NOW, repository });
    const result = await loadTrackManually({
      raw: input({
        date: '2027-01-02',
        title: 'Another song',
        artist: 'Another artist',
        spotifyTrackId: '1301WleyT98MSxVHPZCA6M',
        spotifyUrl: 'https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M',
      }),
      now: NOW,
      repository,
    });
    expect(result.status).toBe('created');
  });
});
