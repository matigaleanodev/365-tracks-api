import { describe, expect, it, vi } from 'vitest';
import type { MusicSelector } from '../../src/music-selection/index.ts';
import { generateDailyTrack } from '../../src/tracks/generate-daily-track.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { importTracks } from '../../src/tracks/manual-import.ts';
import { loadTrackManually } from '../../src/tracks/manual-load.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import {
  DESCRIPTION,
  fakeSpotify,
  ownArtist,
  preparedTrack,
  spotifyId,
  spotifyTrack,
} from '../support/music.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';

const track = (date: string, n: number, overrides: Partial<DailyTrack> = {}) =>
  preparedTrack(date, n, overrides);

describe.each([
  ['DynamoDB (transacción)', () => ({ repository: fakeDynamo().repository })],
  ['memoria', () => ({ repository: new InMemoryTrackRepository() as TrackRepository })],
] as const)('escritura única: %s', (_name, make) => {
  it('guarda una canción nueva y rechaza reutilizar su ID en otra fecha', async () => {
    const { repository } = make();
    expect(await repository.create(track('2027-01-01', 1))).toBe('created');
    expect(await repository.create(track('2027-06-01', 2, { spotifyTrackId: spotifyId(1) }))).toBe(
      'duplicate-track',
    );
    expect(await repository.getByDate('2027-06-01')).toBeNull();
  });

  it('rechaza la misma grabación con otro ID de Spotify (título + artista normalizados)', async () => {
    const { repository } = make();
    await repository.create(track('2027-01-01', 1, { title: 'Blue Monday', artist: 'New Order' }));
    const reissue = track('2027-06-01', 2, {
      title: 'Blue Monday - Remastered 2015',
      artist: 'NEW ORDER',
    });
    expect(await repository.create(reissue)).toBe('duplicate-recording');
  });

  it('respeta los 60 días de artista, antes y después: 59 bloquea, 60 permite', async () => {
    const { repository } = make();
    const same = (date: string, n: number) =>
      track(date, n, { artist: 'Same Artist', title: `Different ${n}` });
    await repository.create(same('2027-03-01', 1));
    expect(await repository.create(same('2027-04-29', 2))).toBe('artist-cooldown'); // +59
    expect(await repository.create(same('2027-01-01', 3))).toBe('artist-cooldown'); // −59
    expect(await repository.create(same('2027-04-30', 4))).toBe('created'); // +60
    expect(await repository.create(same('2027-03-01', 5))).toBe('already-exists');
  });

  it('coincide por ID de artista aunque el nombre difiera, y no confunde cargas sin ID', async () => {
    const { repository } = make();
    await repository.create(
      track('2027-03-01', 1, { artist: 'Prince', spotifyArtistId: 'a'.repeat(22) }),
    );
    expect(
      await repository.create(
        track('2027-03-10', 2, { artist: 'The Artist', spotifyArtistId: 'a'.repeat(22) }),
      ),
    ).toBe('artist-cooldown');
    // Dos cargas manuales sin ID y con artistas distintos no son el mismo artista.
    expect(await repository.create(track('2027-03-10', 3))).toBe('created');
    expect(await repository.create(track('2027-03-12', 4))).toBe('created');
  });

  it('reintentar la misma canción es idempotente: already-exists, sin duplicar', async () => {
    const { repository } = make();
    const first = track('2027-01-01', 1);
    expect(await repository.create(first)).toBe('created');
    expect(await repository.create(first)).toBe('already-exists');
    expect((await repository.list({ limit: 10 })).items).toHaveLength(1);
  });
});

describe('concurrencia sobre DynamoDB (transacciones)', () => {
  it('la misma canción en dos fechas a la vez queda en una sola', async () => {
    const { repository, tracks } = fakeDynamo();
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1)),
      repository.create(track('2027-01-05', 2, { spotifyTrackId: spotifyId(1) })),
    ]);
    expect([...results].sort()).toEqual(['created', 'duplicate-track']);
    expect(tracks()).toHaveLength(1);
  });

  it('la misma grabación con IDs distintos en dos fechas a la vez queda en una sola', async () => {
    const { repository, tracks } = fakeDynamo();
    const same = { title: 'Song', artist: 'Band' };
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1, same)),
      repository.create(track('2027-02-01', 2, same)),
    ]);
    expect([...results].sort()).toEqual(['created', 'duplicate-recording']);
    expect(tracks()).toHaveLength(1);
  });

  it('el mismo artista a menos de 60 días en dos fechas a la vez: gana una y la otra se reevalúa', async () => {
    const { repository, tracks, transactions } = fakeDynamo();
    const band = { artist: 'Band' };
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1, band)),
      repository.create(track('2027-01-20', 2, band)),
    ]);
    expect([...results].sort()).toEqual(['artist-cooldown', 'created']);
    expect(tracks()).toHaveLength(1);
    expect(transactions.mock.calls.length).toBeGreaterThanOrEqual(2); // hubo reintento
  });

  it('el mismo artista con 60 días o más entre fechas, a la vez, conviven sin perder ninguna', async () => {
    const { repository, tracks, items } = fakeDynamo();
    const band = { artist: 'Band' };
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1, band)),
      repository.create(track('2027-03-02', 2, band)),
      repository.create(track('2027-05-01', 3, band)),
    ]);
    expect(results).toEqual(['created', 'created', 'created']);
    expect(tracks()).toHaveLength(3);
    // El registro del artista conserva las tres fechas: ninguna escritura pisó a otra.
    expect(items.get('ARTIST|name#band')?.dates).toHaveLength(3);
  });

  it('un artista y su variante por ID de Spotify chocan aunque lleguen a la vez', async () => {
    const { repository, tracks } = fakeDynamo();
    const id = 'b'.repeat(22);
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1, { artist: 'Prince', spotifyArtistId: id })),
      repository.create(track('2027-01-10', 2, { artist: 'The Artist', spotifyArtistId: id })),
    ]);
    expect([...results].sort()).toEqual(['artist-cooldown', 'created']);
    expect(tracks()).toHaveLength(1);
  });

  it('dos escrituras de la misma fecha: una gana y la otra informa already-exists', async () => {
    const { repository, tracks } = fakeDynamo();
    const results = await Promise.all([
      repository.create(track('2027-01-01', 1)),
      repository.create(track('2027-01-01', 2)),
    ]);
    expect([...results].sort()).toEqual(['already-exists', 'created']);
    expect(tracks()).toHaveLength(1);
  });
});

describe('generateDailyTrack ante una ejecución concurrente', () => {
  const clock = () => new Date('2026-11-21T13:00:00Z');

  it('quien pierde la carrera vuelve a seleccionar y no deja duplicados', async () => {
    const { repository, tracks } = fakeDynamo();
    // Ambas ejecuciones eligen primero la canción 1; la perdedora recibe la 2 al reintentar.
    const queues = new Map<string, number[]>([
      ['2027-01-01', [1]],
      ['2027-01-09', [1, 2]],
    ]);
    const selector: MusicSelector = {
      select: vi.fn((date: string) =>
        Promise.resolve({
          spotifyTrackId: spotifyId(queues.get(date)!.shift()!),
          selectionCriterion: 'classic',
          description: DESCRIPTION,
        }),
      ),
    };
    const spotify = fakeSpotify({
      getTrack: (id) => Promise.resolve(spotifyTrack(id, ownArtist(id))),
    });
    const deps = { repository, selector, spotify, now: clock };

    const [a, b] = await Promise.all([
      generateDailyTrack(deps, '2027-01-01'),
      generateDailyTrack(deps, '2027-01-09'),
    ]);

    expect([a.status, b.status]).toEqual(['created', 'created']);
    const ids = tracks().map((item) => item.spotifyTrackId);
    expect(new Set(ids).size).toBe(2);
    expect(selector.select).toHaveBeenCalledTimes(3);
  });

  it('si no logra una canción única en los intentos falla sin guardar nada', async () => {
    const { repository, tracks } = fakeDynamo();
    await repository.create(track('2027-01-01', 1));
    const selector: MusicSelector = {
      select: vi.fn(() =>
        Promise.resolve({
          spotifyTrackId: spotifyId(1),
          selectionCriterion: 'classic',
          description: DESCRIPTION,
        }),
      ),
    };
    const spotify = fakeSpotify({
      getTrack: (id) => Promise.resolve(spotifyTrack(id, { title: 'Title 1', artist: 'Artist 1' })),
    });
    await expect(
      generateDailyTrack({ repository, selector, spotify, now: clock }, '2027-03-01'),
    ).rejects.toThrow(/conflicts with a concurrent selection/);
    expect(tracks()).toHaveLength(1);
  });
});

describe('cargas manuales', () => {
  const NOW = new Date('2026-11-21T13:00:00Z');
  const input = (n: number, overrides: Record<string, unknown> = {}) => ({
    date: `2027-01-${String(n).padStart(2, '0')}`,
    title: `Song ${n}`,
    artist: `Artist ${n}`,
    album: 'Album',
    releaseYear: 1991,
    spotifyTrackId: spotifyId(n),
    spotifyUrl: `https://open.spotify.com/track/${spotifyId(n)}`,
    selectionCriterion: 'manual',
    description: DESCRIPTION,
    ...overrides,
  });

  it('una carga individual repetida (grabación o artista cercano) se informa como conflicto', async () => {
    const repository = new InMemoryTrackRepository();
    await loadTrackManually({ raw: input(1), now: NOW, repository });
    const result = await loadTrackManually({
      raw: input(2, { artist: 'Artist 1', title: 'Song 1' }),
      now: NOW,
      repository,
    });
    expect(result.status).toBe('conflict');
    expect(await repository.getByDate('2027-01-02')).toBeNull();
  });

  it('el lote que repite un artista a menos de 60 días aborta completo sin escribir', async () => {
    const repository = new InMemoryTrackRepository();
    const report = await importTracks({
      raw: [input(1), input(2, { artist: 'Artist 1' }), input(3)],
      now: NOW,
      repository,
    });
    expect(report.ok).toBe(false);
    expect(report.records.map((r) => r.status)).toEqual(['not-written', 'conflict', 'not-written']);
    expect((await repository.list({ limit: 10 })).items).toHaveLength(0);
  });

  it('el lote con la misma grabación contra lo ya guardado aborta sin escribir', async () => {
    const repository = new InMemoryTrackRepository([
      track('2027-06-01', 9, { title: 'Song 1', artist: 'Artist 1' }),
    ]);
    const report = await importTracks({ raw: [input(1), input(2)], now: NOW, repository });
    expect(report.ok).toBe(false);
    expect(report.records[0]?.status).toBe('conflict');
    expect((await repository.list({ limit: 10 })).items).toHaveLength(1);
  });

  it('una carrera que ocupa el artista después de validar queda como conflicto, sin pisar nada', async () => {
    const base = new InMemoryTrackRepository();
    const racing: TrackRepository = {
      getByDate: base.getByDate.bind(base),
      list: base.list.bind(base),
      create: async (candidate) => {
        if (candidate.date === '2027-01-02') {
          await base.create(track('2027-01-20', 50, { artist: 'Artist 2', title: 'Winner' }));
        }
        return base.create(candidate);
      },
    };
    const report = await importTracks({ raw: [input(1), input(2)], now: NOW, repository: racing });
    expect(report.ok).toBe(false);
    expect(report.records.map((r) => r.status)).toEqual(['created', 'conflict']);
    expect(await base.getByDate('2027-01-02')).toBeNull();
  });
});
