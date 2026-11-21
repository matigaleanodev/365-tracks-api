import { describe, expect, it, vi } from 'vitest';
import {
  isEligibleForPlaylist,
  lastEligibleDate,
  playlistName,
  playlistYear,
} from '../../src/playlist/eligibility.ts';
import { InMemoryPlaylistState } from '../../src/playlist/state.ts';
import { syncPlaylists, type SyncDependencies } from '../../src/playlist/sync.ts';
import type { SpotifyPlaylistClient } from '../../src/spotify/playlist-client.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { preparedTrack, spotifyId } from '../support/music.ts';

const at = (iso: string) => new Date(iso);

describe('corte de elegibilidad (D+1 12:00 UTC)', () => {
  it('a las 11:59:59 UTC todavía no terminó el día anterior en UTC-12', () => {
    expect(lastEligibleDate(at('2027-01-02T11:59:59Z'))).toBe('2026-12-31');
  });

  it('a las 12:00:00 UTC ya es elegible el día anterior', () => {
    expect(lastEligibleDate(at('2027-01-02T12:00:00Z'))).toBe('2027-01-01');
  });

  it('nunca incluye el día en curso ni uno futuro', () => {
    const now = at('2027-06-10T23:59:59Z');
    expect(lastEligibleDate(now)).toBe('2027-06-09');
    expect(isEligibleForPlaylist('2027-06-10', now)).toBe(false);
    expect(isEligibleForPlaylist('2027-06-11', now)).toBe(false);
    expect(isEligibleForPlaylist('2027-06-09', now)).toBe(true);
  });

  it('antes del lanzamiento no hay nada elegible', () => {
    expect(isEligibleForPlaylist('2026-12-31', at('2027-03-01T00:00:00Z'))).toBe(false);
  });

  it('la playlist corresponde al año de la fecha editorial', () => {
    expect(playlistYear('2027-12-31')).toBe(2027);
    expect(playlistYear('2028-01-01')).toBe(2028);
    expect(playlistName(2028)).toBe('365 Tracks 2028');
  });
});

function fakePlaylists(initial: Record<string, string[]> = {}) {
  const lists = new Map<string, string[]>(Object.entries(initial));
  let counter = 0;
  const client = {
    findOwnedByName: vi.fn((name: string) =>
      Promise.resolve(
        [...lists.keys()].includes(`id-${name}`)
          ? { id: `id-${name}`, url: `https://open.spotify.com/playlist/id-${name}` }
          : null,
      ),
    ),
    create: vi.fn(({ name }: { name: string }) => {
      counter += 1;
      lists.set(`id-${name}`, []);
      return Promise.resolve({
        id: `id-${name}`,
        url: `https://open.spotify.com/playlist/id-${name}`,
        n: counter,
      });
    }),
    listTrackIds: vi.fn((id: string) => Promise.resolve([...(lists.get(id) ?? [])])),
    addTracks: vi.fn((id: string, ids: readonly string[]) => {
      lists.set(id, [...(lists.get(id) ?? []), ...ids]);
      return Promise.resolve();
    }),
  };
  return { client: client as unknown as SpotifyPlaylistClient, lists, spies: client };
}

function setup(tracks: DailyTrack[], now: string, playlists = fakePlaylists()) {
  const state = new InMemoryPlaylistState();
  const deps: SyncDependencies = {
    tracks: new InMemoryTrackRepository(tracks),
    state,
    playlists: playlists.client,
    now: () => at(now),
  };
  return { deps, state, ...playlists };
}

const day = (date: string, n: number, overrides: Partial<DailyTrack> = {}) =>
  preparedTrack(date, n, overrides);

describe('syncPlaylists', () => {
  const tracks = [
    day('2027-01-01', 1),
    day('2027-01-02', 2),
    day('2027-01-03', 3),
    day('2027-01-04', 4), // futura respecto de NOW
  ];
  const NOW = '2027-01-04T12:30:00Z'; // última elegible: 2027-01-03

  it('agrega solo días ya terminados, en orden cronológico, creando la playlist anual', async () => {
    const { deps, lists } = setup([...tracks].reverse(), NOW);
    const report = await syncPlaylists(deps);

    expect(report.lastEligible).toBe('2027-01-03');
    expect(report.years).toEqual([
      {
        year: 2027,
        playlistId: 'id-365 Tracks 2027',
        wouldCreatePlaylist: false,
        added: ['2027-01-01', '2027-01-02', '2027-01-03'],
        adopted: [],
      },
    ]);
    expect(lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
  });

  it('nunca agrega la canción de hoy ni una futura', async () => {
    const { deps, lists } = setup(tracks, '2027-01-04T11:59:59Z'); // última elegible: 2027-01-02
    await syncPlaylists(deps);
    const added = lists.get('id-365 Tracks 2027') ?? [];
    expect(added).not.toContain(spotifyId(3));
    expect(added).not.toContain(spotifyId(4));
    expect(added).toEqual([spotifyId(1), spotifyId(2)]);
  });

  it('es idempotente: una segunda ejecución no escribe nada', async () => {
    const ctx = setup(tracks, NOW);
    await syncPlaylists(ctx.deps);
    ctx.spies.addTracks.mockClear();
    ctx.spies.create.mockClear();

    const second = await syncPlaylists(ctx.deps);

    expect(second.years).toEqual([]);
    expect(ctx.spies.addTracks).not.toHaveBeenCalled();
    expect(ctx.spies.create).not.toHaveBeenCalled();
  });

  it('agrega solo lo nuevo cuando pasa un día', async () => {
    const ctx = setup(tracks, NOW);
    await syncPlaylists(ctx.deps);
    const later = { ...ctx.deps, now: () => at('2027-01-05T12:00:00Z') };

    const report = await syncPlaylists(later);

    expect(report.years[0]?.added).toEqual(['2027-01-04']);
    expect(ctx.lists.get('id-365 Tracks 2027')).toHaveLength(4);
  });

  it('recupera una caída entre escribir en Spotify y registrar: adopta sin duplicar', async () => {
    const playlists = fakePlaylists({
      'id-365 Tracks 2027': [spotifyId(1), spotifyId(2)], // ya escritas por una ejecución caída
    });
    const ctx = setup(tracks, NOW, playlists);

    const report = await syncPlaylists(ctx.deps);

    expect(report.years[0]).toMatchObject({
      adopted: ['2027-01-01', '2027-01-02'],
      added: ['2027-01-03'],
    });
    expect(ctx.lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    expect(ctx.spies.create).not.toHaveBeenCalled(); // reutiliza la playlist existente
  });

  it('no duplica la playlist si se cayó tras crearla y antes de guardar su ID', async () => {
    const ctx = setup(tracks, NOW, fakePlaylists({ 'id-365 Tracks 2027': [] }));
    await syncPlaylists(ctx.deps);
    expect(ctx.spies.create).not.toHaveBeenCalled();
    expect(await ctx.state.getPlaylist(2027)).toMatchObject({ playlistId: 'id-365 Tracks 2027' });
  });

  it('el dry-run no crea ni escribe nada, ni en Spotify ni en el estado', async () => {
    const ctx = setup(tracks, NOW);
    const report = await syncPlaylists(ctx.deps, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.years[0]).toMatchObject({
      wouldCreatePlaylist: true,
      added: ['2027-01-01', '2027-01-02', '2027-01-03'],
    });
    expect(ctx.spies.create).not.toHaveBeenCalled();
    expect(ctx.spies.addTracks).not.toHaveBeenCalled();
    expect(await ctx.state.getPlaylist(2027)).toBeNull();
    expect(await ctx.state.listSynced(2027)).toEqual([]);
  });

  it('el cambio de año usa una playlist nueva y no mezcla años', async () => {
    const yearEnd = [day('2027-12-31', 1), day('2028-01-01', 2), day('2028-01-02', 3)];
    const ctx = setup(yearEnd, '2028-01-03T12:00:00Z'); // última elegible: 2028-01-02
    const report = await syncPlaylists(ctx.deps);

    expect(report.years.map((y) => y.year)).toEqual([2027, 2028]);
    expect(ctx.lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1)]);
    expect(ctx.lists.get('id-365 Tracks 2028')).toEqual([spotifyId(2), spotifyId(3)]);
  });

  it('el 31 de diciembre de 2027 no entra a la playlist 2028 ni 2027 antes del corte', async () => {
    const ctx = setup([day('2027-12-31', 1)], '2028-01-01T11:59:59Z');
    const report = await syncPlaylists(ctx.deps);
    expect(report.years).toEqual([]);
  });

  it('omite las canciones incompletas elegibles y lo informa', async () => {
    const broken = day('2027-01-02', 2, { description: undefined });
    const ctx = setup([day('2027-01-01', 1), broken, day('2027-01-03', 3)], NOW);
    const report = await syncPlaylists(ctx.deps);

    expect(report.skippedIncomplete).toEqual(['2027-01-02']);
    expect(ctx.lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1), spotifyId(3)]);
  });

  it('ignora fechas previas al lanzamiento', async () => {
    const ctx = setup([day('2026-12-31', 9), day('2027-01-01', 1)], NOW);
    await syncPlaylists(ctx.deps);
    expect(ctx.lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1)]);
  });

  it('no agrega dos veces el mismo ID de Spotify en una ejecución', async () => {
    const ctx = setup([day('2027-01-01', 1), day('2027-01-02', 1)], NOW);
    await syncPlaylists(ctx.deps);
    expect(ctx.lists.get('id-365 Tracks 2027')).toEqual([spotifyId(1)]);
  });

  it('si falla la escritura en Spotify no registra nada y el reintento completa', async () => {
    const ctx = setup(tracks, NOW);
    ctx.spies.addTracks.mockRejectedValueOnce(new Error('spotify down'));

    await expect(syncPlaylists(ctx.deps)).rejects.toThrow('spotify down');
    expect(await ctx.state.listSynced(2027)).toEqual([]);

    const retry = await syncPlaylists(ctx.deps);
    expect(retry.years[0]?.added).toHaveLength(3);
    expect(ctx.lists.get('id-365 Tracks 2027')).toHaveLength(3);
  });
});
