import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHistory, findViolation, identityOf } from '../../src/music-selection/rules.ts';
import { recordingKeyOf } from '../../src/music-selection/recording-key.ts';
import { artistIdentity, artistNameKey } from '../../src/tracks/artist-key.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { importTracks } from '../../src/tracks/manual-import.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';
import { DESCRIPTION, preparedTrack } from '../support/music.ts';

const NOW = new Date('2026-11-21T13:00:00Z');
const ARTIST_A = 'A'.repeat(22);
const ARTIST_B = 'B'.repeat(22);

type Pair = [DailyTrack, DailyTrack];
const pair = (
  firstArtist: string,
  secondArtist: string,
  overrides: [Partial<DailyTrack>, Partial<DailyTrack>] = [{}, {}],
): Pair => [
  preparedTrack('2027-01-01', 1, { artist: firstArtist, title: 'Uno', ...overrides[0] }),
  preparedTrack('2027-01-02', 2, { artist: secondArtist, title: 'Dos', ...overrides[1] }),
];

/** Los cuatro caminos que deciden la identidad del artista; devuelven el resultado de la 2.ª canción. */
const paths: Record<string, (tracks: Pair) => Promise<string>> = {
  async dynamo([first, second]) {
    const { repository } = fakeDynamo();
    await repository.create(first);
    return repository.create(second);
  },
  async memory([first, second]) {
    const repository = new InMemoryTrackRepository();
    await repository.create(first);
    return repository.create(second);
  },
  async selector([first, second]) {
    return findViolation(identityOf(second), second.date, buildHistory([first])) ?? 'created';
  },
  async importDryRun(tracks) {
    return importOutcome(tracks);
  },
  async importMemory(tracks) {
    return importOutcome(tracks, new InMemoryTrackRepository());
  },
};

async function importOutcome(tracks: Pair, repository?: TrackRepository): Promise<string> {
  // `createdAt` lo fija el sistema: el archivo de importación no lo admite.
  const raw = tracks.map(({ createdAt: _createdAt, ...track }) => ({
    ...track,
    description: DESCRIPTION,
  }));
  const report = await importTracks({ raw, now: NOW, ...(repository && { repository }) });
  const conflict = report.records.find((record) => record.status === 'conflict');
  // El mensaje del conflicto nombra la regla: se traduce al mismo vocabulario que los demás.
  if (conflict) return /artist/i.test(conflict.errors.join(' ')) ? 'artist-cooldown' : 'conflict';
  return report.ok ? 'created' : 'conflict';
}

describe.each(Object.entries(paths))('identidad de artista: %s', (_, run) => {
  it('"!!!" y "***" son artistas distintos (títulos, IDs de pista y de artista distintos)', async () => {
    expect(await run(pair('!!!', '***'))).toBe('created');
    expect(
      await run(pair('!!!', '***', [{ spotifyArtistId: ARTIST_A }, { spotifyArtistId: ARTIST_B }])),
    ).toBe('created');
  });

  it('"!!!" dos veces en fechas consecutivas es el mismo artista', async () => {
    expect(await run(pair('!!!', '!!!'))).toBe('artist-cooldown');
  });

  it('"The Beatles" y "Beatles" siguen siendo el mismo artista', async () => {
    expect(await run(pair('The Beatles', 'Beatles'))).toBe('artist-cooldown');
  });

  it('el mismo ID de artista de Spotify bloquea aunque los nombres de símbolos difieran', async () => {
    expect(
      await run(pair('!!!', '***', [{ spotifyArtistId: ARTIST_A }, { spotifyArtistId: ARTIST_A }])),
    ).toBe('artist-cooldown');
  });
});

describe('artistIdentity', () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  it('no cambia las claves de control de Dynamo existentes', () => {
    expect(artistNameKey('The Beatles')).toBe('name#beatles');
    const long = 'a'.repeat(300);
    expect(artistNameKey(long)).toBe(`namehash#${sha(long)}`);
    expect(artistNameKey('!!!')).toBe(`namehash#raw:${sha('!!!')}`);
    expect(artistNameKey('***')).not.toBe(artistNameKey('!!!'));
  });

  it('usa el nombre normalizado, o raw: para nombres solo de símbolos', () => {
    expect(artistIdentity('The Beatles')).toBe('beatles');
    expect(artistIdentity('!!!')).toBe(`raw:${sha('!!!')}`);
  });

  it('la clave de grabación solo cambia para artistas de símbolos', () => {
    expect(recordingKeyOf('Song', 'The Beatles')).toBe('song|beatles');
    expect(recordingKeyOf('Song', '!!!')).not.toBe(recordingKeyOf('Song', '***'));
  });
});
