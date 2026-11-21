import { describe, expect, it, vi } from 'vitest';
import {
  createEditorialSelector,
  SelectionFailedError,
} from '../../src/music-selection/selector.ts';
import {
  ProposalResponseError,
  type ProposalRequest,
  type SongProposal,
  type SongProposer,
} from '../../src/music-selection/proposer.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import {
  DESCRIPTION,
  fakeSpotify,
  preparedTrack,
  spotifyId,
  spotifyTrack,
} from '../support/music.ts';

const DATE = '2027-03-15';

const proposal = (title: string, artist: string, overrides: Partial<SongProposal> = {}) => ({
  title,
  artist,
  releaseYear: 1990,
  releaseDate: null,
  description: DESCRIPTION,
  ...overrides,
});

/** Spotify falso con un catálogo fijo: busca por título y artista exactos. */
function catalogSpotify(entries: { title: string; artist: string; n: number; year?: number }[]) {
  const tracks = entries.map(({ title, artist, n, year = 1990 }) =>
    spotifyTrack(spotifyId(n), {
      title,
      artist,
      artistId: `artist${String(n).padStart(16, '0')}`,
      artists: [{ id: `artist${String(n).padStart(16, '0')}`, name: artist }],
      releaseYear: year,
      releaseDate: `${year}-06-01`,
    }),
  );
  return fakeSpotify({
    searchTracks: vi.fn(({ title, artist }) =>
      Promise.resolve(tracks.filter((t) => t.title === title && t.artist === artist)),
    ),
  });
}

function scriptedProposer(rounds: (SongProposal[] | Error)[]) {
  const queue = [...rounds];
  const propose = vi.fn((_request: ProposalRequest) => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new ProposalResponseError('script exhausted'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { propose } satisfies SongProposer;
}

const setup = (
  rounds: (SongProposal[] | Error)[],
  entries: Parameters<typeof catalogSpotify>[0],
  stored = [] as ReturnType<typeof preparedTrack>[],
) => {
  const proposer = scriptedProposer(rounds);
  const spotify = catalogSpotify(entries);
  const selector = createEditorialSelector({
    proposer,
    spotify,
    repository: new InMemoryTrackRepository(stored),
  });
  return { proposer, spotify, selector };
};

describe('createEditorialSelector', () => {
  it('resuelve la propuesta en Spotify y devuelve ID, criterio y descripción', async () => {
    const { selector } = setup(
      [[proposal('Song A', 'Band A')]],
      [{ title: 'Song A', artist: 'Band A', n: 1 }],
    );
    await expect(selector.select(DATE)).resolves.toEqual({
      spotifyTrackId: spotifyId(1),
      selectionCriterion: expect.any(String),
      description: DESCRIPTION,
    });
  });

  it('descarta propuestas que Spotify no resuelve y toma la siguiente', async () => {
    const { selector, spotify } = setup(
      [[proposal('Ghost', 'Nobody'), proposal('Song B', 'Band B')]],
      [{ title: 'Song B', artist: 'Band B', n: 2 }],
    );
    const result = await selector.select(DATE);
    expect(result.spotifyTrackId).toBe(spotifyId(2));
    expect(spotify.searchTracks).toHaveBeenCalledTimes(2);
  });

  it('nunca repite una canción ya preparada, aunque el modelo la proponga', async () => {
    const { selector } = setup(
      [[proposal('Taken', 'Band T'), proposal('Fresh', 'Band F')]],
      [
        { title: 'Taken', artist: 'Band T', n: 1 },
        { title: 'Fresh', artist: 'Band F', n: 2 },
      ],
      [preparedTrack('2027-03-01', 1, { artist: 'Band T', title: 'Taken' })],
    );
    expect((await selector.select(DATE)).spotifyTrackId).toBe(spotifyId(2));
  });

  it('no repite artista dentro de 60 días (por ID)', async () => {
    const { selector } = setup(
      [[proposal('Second', 'Band X'), proposal('Other', 'Band Y')]],
      [
        { title: 'Second', artist: 'Band X', n: 5 },
        { title: 'Other', artist: 'Band Y', n: 6 },
      ],
      [
        preparedTrack('2027-03-01', 5, {
          title: 'First',
          artist: 'Band X',
          spotifyTrackId: spotifyId(50),
          spotifyArtistId: `artist${String(5).padStart(16, '0')}`,
        }),
      ],
    );
    expect((await selector.select(DATE)).spotifyTrackId).toBe(spotifyId(6));
  });

  it('descarta una descripción inválida sin consultar Spotify', async () => {
    const { selector, spotify } = setup(
      [
        [
          proposal('Bad', 'Band', { description: 'Corta.' }),
          proposal('Month', 'Band2', { description: `${DESCRIPTION} Salió en marzo.` }),
          proposal('Good', 'Band3'),
        ],
      ],
      [
        { title: 'Bad', artist: 'Band', n: 1 },
        { title: 'Month', artist: 'Band2', n: 2 },
        { title: 'Good', artist: 'Band3', n: 3 },
      ],
    );
    expect((await selector.select(DATE)).spotifyTrackId).toBe(spotifyId(3));
    expect(spotify.searchTracks).toHaveBeenCalledTimes(1);
  });

  it('rechaza un año en la descripción que Spotify no confirma', async () => {
    const { selector } = setup(
      [
        [
          proposal('Dated', 'Band D', {
            releaseYear: 1990,
            description: `${DESCRIPTION} De 1990.`,
          }),
          proposal('Plain', 'Band P'),
        ],
      ],
      [
        { title: 'Dated', artist: 'Band D', n: 1, year: 1991 },
        { title: 'Plain', artist: 'Band P', n: 2 },
      ],
    );
    expect((await selector.select(DATE)).spotifyTrackId).toBe(spotifyId(2));
  });

  it('una respuesta inválida del modelo pierde la ronda y se sigue intentando', async () => {
    const { selector, proposer } = setup(
      [new ProposalResponseError('bad'), [proposal('Song A', 'Band A')]],
      [{ title: 'Song A', artist: 'Band A', n: 1 }],
    );
    await expect(selector.select(DATE)).resolves.toMatchObject({ spotifyTrackId: spotifyId(1) });
    expect(proposer.propose).toHaveBeenCalledTimes(2);
  });

  it('un fallo de red o de cuota del modelo se propaga (no se oculta como "sin canción")', async () => {
    const { selector } = setup([new Error('quota')], []);
    await expect(selector.select(DATE)).rejects.toThrow('quota');
  });

  it('acota el trabajo: tras los criterios y rondas máximos falla con conteos, sin títulos', async () => {
    const proposer = scriptedProposer(
      Array.from({ length: 20 }, () => [proposal('Ghost', 'Nobody')]),
    );
    const selector = createEditorialSelector({
      proposer,
      spotify: catalogSpotify([]),
      repository: new InMemoryTrackRepository(),
      maxCriteriaTried: 2,
      maxRoundsPerCriterion: 2,
    });
    const error = await selector.select(DATE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SelectionFailedError);
    expect(proposer.propose).toHaveBeenCalledTimes(4);
    expect((error as Error).message).toContain('2027-03-15');
    expect((error as Error).message).not.toContain('Ghost');
    expect((error as Error).message).not.toContain('Nobody');
  });

  it('no vuelve a pedir ni evaluar propuestas ya consideradas', async () => {
    const { selector, spotify, proposer } = setup(
      [[proposal('Ghost', 'Nobody')], [proposal('Ghost', 'Nobody'), proposal('Real', 'Band R')]],
      [{ title: 'Real', artist: 'Band R', n: 7 }],
    );
    await selector.select(DATE);
    expect(spotify.searchTracks).toHaveBeenCalledTimes(2);
    const second = proposer.propose.mock.calls[1]?.[0] as ProposalRequest;
    expect(second.rejected).toEqual([{ title: 'Ghost', artist: 'Nobody' }]);
  });

  it('la solicitud al modelo nunca contiene datos de Spotify', async () => {
    const { selector, proposer } = setup(
      [[proposal('Song A', 'Band A')]],
      [{ title: 'Song A', artist: 'Band A', n: 1 }],
    );
    await selector.select(DATE);
    const serialized = JSON.stringify(proposer.propose.mock.calls);
    expect(serialized).not.toContain(spotifyId(1));
    expect(serialized).not.toContain('open.spotify.com');
  });

  it('con una efeméride exige que Spotify confirme el día exacto', async () => {
    const proposer = scriptedProposer([
      [proposal('Wrong Day', 'Band W', { releaseDate: '1990-03-15' })],
    ]);
    const spotify = catalogSpotify([{ title: 'Wrong Day', artist: 'Band W', n: 1 }]); // 06-01
    const selector = createEditorialSelector({
      proposer,
      spotify,
      repository: new InMemoryTrackRepository(),
      // Solo el criterio de aniversario, para aislar la regla.
      weights: {
        classic: 0,
        'hidden-gem': 0,
        'music-anniversary': 1,
        'genre-exploration': 0,
        'recent-release': 0,
        'cultural-date': 0,
      },
      maxRoundsPerCriterion: 1,
    });
    await expect(selector.select(DATE)).rejects.toBeInstanceOf(SelectionFailedError);
  });
});
