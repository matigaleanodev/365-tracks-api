import { describe, expect, it, vi } from 'vitest';
import { importTracks, MAX_IMPORT_RECORDS } from '../../src/tracks/manual-import.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { TrackRepository } from '../../src/tracks/repository.ts';
import { parseTrackInput } from '../../src/tracks/track-input.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { DESCRIPTION } from '../support/music.ts';

const NOW = new Date('2026-11-21T13:00:00Z');

const spotifyId = (n: number) => `track${String(n).padStart(17, '0')}`;
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
const month = () => Array.from({ length: 30 }, (_, index) => input(index + 1));
const statuses = (report: { records: { status: string }[] }) => report.records.map((r) => r.status);

describe('importTracks', () => {
  it('importa el primer mes completo (1 al 30 de enero de 2027)', async () => {
    const repository = new InMemoryTrackRepository();
    const report = await importTracks({ raw: month(), now: NOW, repository });
    expect(report.ok).toBe(true);
    expect(report.records.every((r) => r.status === 'created')).toBe(true);
    expect((await repository.list({ limit: 100 })).items).toHaveLength(30);
    expect((await repository.getByDate('2027-01-30'))?.title).toBe('Song 30');
  });

  it('--dry-run (sin repositorio) valida sin escribir', async () => {
    const report = await importTracks({ raw: month(), now: NOW });
    expect(report.ok).toBe(true);
    expect(statuses(report).every((status) => status === 'valid')).toBe(true);
  });

  it('el dry-run también detecta artista repetido y grabación repetida dentro del archivo', async () => {
    const sameArtist = await importTracks({
      raw: [input(1), input(2, { artist: 'Artist 1' })],
      now: NOW,
    });
    expect(sameArtist.ok).toBe(false);
    expect(statuses(sameArtist)).toEqual(['not-written', 'conflict']);
    const sameRecording = await importTracks({
      raw: [input(1), input(2, { title: 'Song 1', artist: 'Artist 1', date: '2027-09-01' })],
      now: NOW,
    });
    expect(statuses(sameRecording)).toEqual(['not-written', 'conflict']);
  });

  it('exige un array no vacío y acotado', async () => {
    for (const raw of [
      {},
      'x',
      [],
      Array.from({ length: MAX_IMPORT_RECORDS + 1 }, () => input(1)),
    ]) {
      const report = await importTracks({ raw, now: NOW });
      expect(report.ok).toBe(false);
      expect(report.errors).not.toEqual([]);
    }
  });

  it('un registro inválido aborta todo el lote antes de escribir', async () => {
    const repository = new InMemoryTrackRepository();
    const create = vi.spyOn(repository, 'create');
    const raw = [input(1), input(2, { title: '' }), input(3)];
    const report = await importTracks({ raw, now: NOW, repository });
    expect(report.ok).toBe(false);
    expect(statuses(report)).toEqual(['not-written', 'invalid', 'not-written']);
    expect(report.records[1]?.errors.join()).toContain('title');
    expect(create).not.toHaveBeenCalled();
  });

  it('detecta fechas duplicadas dentro del archivo e informa ambos registros', async () => {
    const repository = new InMemoryTrackRepository();
    const raw = [input(1), input(2, { date: '2027-01-01' }), input(3)];
    const report = await importTracks({ raw, now: NOW, repository });
    expect(report.ok).toBe(false);
    expect(statuses(report)).toEqual(['conflict', 'conflict', 'not-written']);
    expect(report.records[0]?.errors[0]).toContain('2027-01-01');
    expect((await repository.list({ limit: 10 })).items).toEqual([]);
  });

  it('detecta IDs de Spotify duplicados dentro del archivo', async () => {
    const repository = new InMemoryTrackRepository();
    const raw = [
      input(1),
      input(2, { spotifyTrackId: spotifyId(1), spotifyUrl: input(1).spotifyUrl }),
    ];
    const report = await importTracks({ raw, now: NOW, repository });
    expect(report.ok).toBe(false);
    expect(statuses(report)).toEqual(['conflict', 'conflict']);
    expect(report.records[1]?.errors[0]).toContain(spotifyId(1));
    expect((await repository.list({ limit: 10 })).items).toEqual([]);
  });

  it('también valida duplicados en dry-run', async () => {
    const report = await importTracks({ raw: [input(1), input(1)], now: NOW });
    expect(report.ok).toBe(false);
  });

  it('rechaza fechas anteriores al lanzamiento y no sobrescribe nada', async () => {
    const report = await importTracks({ raw: [input(1, { date: '2026-12-31' })], now: NOW });
    expect(report.ok).toBe(false);
    expect(report.records[0]?.errors.join()).toContain('publication start');
  });

  it('no sobrescribe fechas existentes y completa solo las que faltan', async () => {
    const repository = new InMemoryTrackRepository();
    await importTracks({ raw: [input(1), input(2)], now: NOW, repository });
    const original = await repository.getByDate('2027-01-01');

    // El primero repite la fecha con otro título: se informa y no se toca.
    const raw = [input(1, { title: 'Changed' }), input(2), input(3)];
    const report = await importTracks({ raw, now: NOW, repository });

    expect(report.ok).toBe(true);
    expect(statuses(report)).toEqual(['already-exists', 'already-exists', 'created']);
    expect(await repository.getByDate('2027-01-01')).toEqual(original);
  });

  it('repetir la importación completa es seguro e idempotente', async () => {
    const repository = new InMemoryTrackRepository();
    await importTracks({ raw: month(), now: NOW, repository });
    const again = await importTracks({ raw: month(), now: NOW, repository });
    expect(again.ok).toBe(true);
    expect(statuses(again).every((status) => status === 'already-exists')).toBe(true);
  });

  it('una canción ya guardada en otra fecha bloquea el lote sin escribir nada', async () => {
    const repository = new InMemoryTrackRepository();
    await importTracks({ raw: [input(1)], now: NOW, repository });
    const raw = [
      input(2),
      input(3, { spotifyTrackId: spotifyId(1), spotifyUrl: input(1).spotifyUrl }),
    ];
    const report = await importTracks({ raw, now: NOW, repository });
    expect(report.ok).toBe(false);
    expect(statuses(report)).toEqual(['not-written', 'conflict']);
    expect(report.records[1]?.errors[0]).toContain('already used on 2027-01-01');
    expect(await repository.getByDate('2027-01-02')).toBeNull();
  });

  it('pagina el catálogo guardado completo para detectar repetidas', async () => {
    const repository = new InMemoryTrackRepository();
    for (let day = 1; day <= 30; day += 1) {
      await repository.create(storedTrack(day));
    }
    // Más de 100 ítems fuerza más de una página del repositorio.
    for (let n = 1; n <= 80; n += 1) {
      await repository.create({
        ...storedTrack(1),
        date: `2027-02-${String(n).padStart(2, '0')}`,
        spotifyTrackId: spotifyId(100 + n),
        title: `Clone ${n}`,
        artist: `Clone artist ${n}`,
      });
    }
    const list = vi.spyOn(repository, 'list');
    const report = await importTracks({
      raw: [
        input(2, {
          date: '2028-01-01',
          spotifyTrackId: spotifyId(1),
          spotifyUrl: input(1).spotifyUrl,
        }),
      ],
      now: NOW,
      repository,
    });
    expect(report.ok).toBe(false);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it('una carrera que ocupa la fecha antes de escribir se informa como existente', async () => {
    const base = new InMemoryTrackRepository();
    const racing: TrackRepository = {
      getByDate: base.getByDate.bind(base),
      list: base.list.bind(base),
      create: async (track) => {
        if (track.date === '2027-01-02') {
          await base.create({ ...track, title: 'Winner' });
        }
        return base.create(track);
      },
    };
    const report = await importTracks({ raw: [input(1), input(2)], now: NOW, repository: racing });
    expect(statuses(report)).toEqual(['created', 'already-exists']);
    expect((await base.getByDate('2027-01-02'))?.title).toBe('Winner');
  });
});

function storedTrack(day: number): DailyTrack {
  const parsed = parseTrackInput(input(day), NOW);
  if (!parsed.ok) throw new Error('fixture invalid');
  return parsed.track;
}
