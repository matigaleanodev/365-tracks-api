import { describe, expect, it, vi } from 'vitest';
import {
  isEligibleForPlaylist,
  lastEligibleDate,
  playlistName,
  playlistYear,
} from '../../src/playlist/eligibility.ts';
import { InMemoryPlaylistState } from '../../src/playlist/state.ts';
import {
  LOCK_TTL_MS,
  syncPlaylists,
  WriteBudgetExhaustedError,
  type SyncDependencies,
} from '../../src/playlist/sync.ts';
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
    expect(playlistName(2028)).toBe('Daywave 2028');
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
    create: vi.fn(({ name }: { name: string }, guard?: (startsInMs: number) => void) => {
      guard?.(0);
      counter += 1;
      lists.set(`id-${name}`, []);
      return Promise.resolve({
        id: `id-${name}`,
        url: `https://open.spotify.com/playlist/id-${name}`,
        n: counter,
      });
    }),
    listItems: vi.fn((id: string) => Promise.resolve([...(lists.get(id) ?? [])])),
    addTracks: vi.fn(
      (id: string, ids: readonly string[], position?: number, guard?: (n: number) => void) => {
        guard?.(0);
        const list = [...(lists.get(id) ?? [])];
        list.splice(position ?? list.length, 0, ...ids);
        lists.set(id, list);
        return Promise.resolve();
      },
    ),
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
        playlistId: 'id-Daywave 2027',
        wouldCreatePlaylist: false,
        added: ['2027-01-01', '2027-01-02', '2027-01-03'],
        adopted: [],
        external: 0,
      },
    ]);
    expect(lists.get('id-Daywave 2027')).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
  });

  it('nunca agrega la canción de hoy ni una futura', async () => {
    const { deps, lists } = setup(tracks, '2027-01-04T11:59:59Z'); // última elegible: 2027-01-02
    await syncPlaylists(deps);
    const added = lists.get('id-Daywave 2027') ?? [];
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
    expect(ctx.lists.get('id-Daywave 2027')).toHaveLength(4);
  });

  it('recupera una caída entre escribir en Spotify y registrar: adopta sin duplicar', async () => {
    const playlists = fakePlaylists({
      'id-Daywave 2027': [spotifyId(1), spotifyId(2)], // ya escritas por una ejecución caída
    });
    const ctx = setup(tracks, NOW, playlists);

    const report = await syncPlaylists(ctx.deps);

    expect(report.years[0]).toMatchObject({
      adopted: ['2027-01-01', '2027-01-02'],
      added: ['2027-01-03'],
    });
    expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    expect(ctx.spies.create).not.toHaveBeenCalled(); // reutiliza la playlist existente
  });

  it('no duplica la playlist si se cayó tras crearla y antes de guardar su ID', async () => {
    const ctx = setup(tracks, NOW, fakePlaylists({ 'id-Daywave 2027': [] }));
    await syncPlaylists(ctx.deps);
    expect(ctx.spies.create).not.toHaveBeenCalled();
    expect(await ctx.state.getPlaylist(2027)).toMatchObject({ playlistId: 'id-Daywave 2027' });
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
    expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1)]);
    expect(ctx.lists.get('id-Daywave 2028')).toEqual([spotifyId(2), spotifyId(3)]);
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
    expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1), spotifyId(3)]);
  });

  it('ignora fechas previas al lanzamiento', async () => {
    const ctx = setup([day('2026-12-31', 9), day('2027-01-01', 1)], NOW);
    await syncPlaylists(ctx.deps);
    expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1)]);
  });

  it('no agrega dos veces el mismo ID de Spotify en una ejecución', async () => {
    const ctx = setup([day('2027-01-01', 1), day('2027-01-02', 1)], NOW);
    await syncPlaylists(ctx.deps);
    expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1)]);
  });

  it('si falla la escritura en Spotify no registra nada y el reintento completa', async () => {
    const ctx = setup(tracks, NOW);
    ctx.spies.addTracks.mockRejectedValueOnce(new Error('spotify down'));

    await expect(syncPlaylists(ctx.deps)).rejects.toThrow('spotify down');
    expect(await ctx.state.listSynced(2027)).toEqual([]);

    const retry = await syncPlaylists(ctx.deps);
    expect(retry.years[0]?.added).toHaveLength(3);
    expect(ctx.lists.get('id-Daywave 2027')).toHaveLength(3);
  });

  describe('reconciliación con la playlist real', () => {
    const PL = 'id-Daywave 2027';
    const synced = async (ctx: ReturnType<typeof setup>) => {
      await syncPlaylists(ctx.deps);
      ctx.spies.addTracks.mockClear();
      return ctx;
    };

    it('recupera una canción borrada a mano aunque figure como sincronizada', async () => {
      const ctx = await synced(setup(tracks, NOW));
      ctx.lists.set(PL, [spotifyId(1), spotifyId(3)]); // borraron la del 2

      const report = await syncPlaylists(ctx.deps);

      expect(report.years[0]?.added).toEqual(['2027-01-02']);
      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    });

    it('recupera varias faltantes en su lugar cronológico, sin duplicar', async () => {
      const ctx = await synced(setup(tracks, NOW));
      ctx.lists.set(PL, [spotifyId(2)]); // borraron la primera y la última

      await syncPlaylists(ctx.deps);
      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);

      ctx.spies.addTracks.mockClear();
      const again = await syncPlaylists(ctx.deps);
      expect(again.years).toEqual([]);
      expect(ctx.spies.addTracks).not.toHaveBeenCalled();
    });

    it('si la playlist quedó vacía la rearma completa y en orden', async () => {
      const ctx = await synced(setup(tracks, NOW));
      ctx.lists.set(PL, []);
      await syncPlaylists(ctx.deps);
      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    });

    it('nunca borra ni mueve canciones ajenas agregadas en Spotify', async () => {
      const ctx = await synced(setup(tracks, NOW));
      ctx.lists.set(PL, [spotifyId(1), 'externaaaaaaaaaaaaaaaa', spotifyId(3)]);

      const report = await syncPlaylists(ctx.deps);

      expect(report.years[0]).toMatchObject({ added: ['2027-01-02'], external: 1 });
      expect(ctx.lists.get(PL)).toContain('externaaaaaaaaaaaaaaaa');
      expect(ctx.lists.get(PL)).toHaveLength(4);
    });

    it('no agrega canciones no elegibles ni incompletas al recuperar', async () => {
      const mixed = [
        day('2027-01-01', 1),
        day('2027-01-02', 2, { description: '' }), // incompleta
        day('2027-01-03', 3),
        day('2027-01-04', 4), // futura
      ];
      const ctx = await synced(setup(mixed, NOW));
      ctx.lists.set(PL, []);

      const report = await syncPlaylists(ctx.deps);

      expect(report.skippedIncomplete).toEqual(['2027-01-02']);
      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(3)]);
    });

    it('una escritura parcial se completa en el reintento sin duplicar', async () => {
      const ctx = await synced(setup(tracks, NOW));
      ctx.lists.set(PL, []);
      ctx.spies.addTracks.mockImplementationOnce((id: string, ids: readonly string[]) => {
        ctx.lists.set(PL, [...ids.slice(0, 1)]); // llegó una sola antes de fallar
        return Promise.reject(new Error('timeout'));
      });

      await expect(syncPlaylists(ctx.deps)).rejects.toThrow('timeout');
      await syncPlaylists(ctx.deps);

      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    });
  });

  describe('lease y posiciones físicas', () => {
    const PL = 'id-Daywave 2027';

    it('no escribe si el candado está por vencer y la siguiente ejecución relee', async () => {
      const ctx = setup(tracks, NOW);
      let offsetMs = 0;
      ctx.deps.now = () => new Date(at(NOW).getTime() + offsetMs);
      // La playlist se crea con el candado vigente; luego pasa el TTL antes del primer bloque.
      ctx.spies.listItems.mockImplementationOnce(() => {
        offsetMs = LOCK_TTL_MS;
        return Promise.resolve([]);
      });
      await expect(syncPlaylists(ctx.deps)).rejects.toBeInstanceOf(WriteBudgetExhaustedError);
      expect(ctx.spies.addTracks).toHaveBeenCalledTimes(1);
      expect(ctx.lists.get(PL)).toEqual([]);

      offsetMs = 0;
      const retry = await syncPlaylists(ctx.deps);
      expect(retry.skippedLocked).toEqual([]);
      expect(ctx.lists.get(PL)).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
    });

    it('con un ítem sin ID (archivo local) la posición cuenta todos los ítems físicos', async () => {
      const ctx = setup(
        tracks,
        NOW,
        fakePlaylists({ [PL]: [null as unknown as string, spotifyId(1), spotifyId(3)] }),
      );
      await syncPlaylists(ctx.deps);
      expect(ctx.lists.get(PL)).toEqual([null, spotifyId(1), spotifyId(2), spotifyId(3)]);
      expect(ctx.spies.addTracks).toHaveBeenCalledWith(PL, [spotifyId(2)], 2, expect.any(Function));
    });

    it('actualiza el registro cuando una fecha cambia de ID y el nuevo ya está en la playlist', async () => {
      const ctx = setup(tracks, NOW);
      await syncPlaylists(ctx.deps);
      const swapped = day('2027-01-02', 22);
      ctx.lists.set(PL, [spotifyId(1), swapped.spotifyTrackId, spotifyId(3)]);
      const deps = {
        ...ctx.deps,
        tracks: new InMemoryTrackRepository([tracks[0]!, swapped, tracks[2]!]),
      };
      await syncPlaylists(deps);
      const entry = (await ctx.state.listSynced(2027)).find((e) => e.date === '2027-01-02');
      expect(entry?.spotifyTrackId).toBe(swapped.spotifyTrackId);
    });

    it('documenta la política: duplicados y orden existentes no se reparan ni se agrega nada extra', async () => {
      const ctx = setup(
        tracks,
        NOW,
        fakePlaylists({ [PL]: [spotifyId(3), spotifyId(1), spotifyId(1)] }),
      );
      await syncPlaylists(ctx.deps);
      expect(ctx.lists.get(PL)?.filter((id) => id === spotifyId(1))).toHaveLength(2);
      expect(ctx.lists.get(PL)).toContain(spotifyId(2));
      expect(ctx.lists.get(PL)).toHaveLength(4);
    });
  });

  describe('concurrencia por playlist anual', () => {
    it('dos ejecuciones simultáneas no duplican canciones', async () => {
      const ctx = setup(tracks, NOW);
      const [a, b] = await Promise.all([syncPlaylists(ctx.deps), syncPlaylists(ctx.deps)]);

      expect(ctx.lists.get('id-Daywave 2027')).toEqual([spotifyId(1), spotifyId(2), spotifyId(3)]);
      expect(ctx.spies.create).toHaveBeenCalledTimes(1);
      expect([a.skippedLocked, b.skippedLocked].flat()).toEqual([2027]);
    });

    it('si el candado está vigente no escribe y lo informa', async () => {
      const ctx = setup(tracks, NOW);
      await ctx.state.acquireLock(2027, 'otra-ejecucion', at(NOW).getTime(), LOCK_TTL_MS);

      const report = await syncPlaylists(ctx.deps);

      expect(report.skippedLocked).toEqual([2027]);
      expect(ctx.spies.addTracks).not.toHaveBeenCalled();
    });

    it('un candado vencido (ejecución caída) se recupera solo', async () => {
      const ctx = setup(tracks, NOW);
      await ctx.state.acquireLock(2027, 'caida', at(NOW).getTime() - LOCK_TTL_MS - 1, LOCK_TTL_MS);

      const report = await syncPlaylists(ctx.deps);

      expect(report.skippedLocked).toEqual([]);
      expect(ctx.lists.get('id-Daywave 2027')).toHaveLength(3);
    });

    it('libera el candado aunque falle la escritura, y no libera uno ajeno', async () => {
      const ctx = setup(tracks, NOW);
      ctx.spies.addTracks.mockRejectedValueOnce(new Error('spotify down'));
      await expect(syncPlaylists(ctx.deps)).rejects.toThrow('spotify down');
      expect(await syncPlaylists(ctx.deps)).toMatchObject({ skippedLocked: [] });

      await ctx.state.acquireLock(2027, 'otro', at(NOW).getTime(), LOCK_TTL_MS);
      await ctx.state.releaseLock(2027, 'distinto');
      expect(await ctx.state.acquireLock(2027, 'tercero', at(NOW).getTime(), LOCK_TTL_MS)).toBe(
        false,
      );
    });

    it('el dry-run no toma el candado', async () => {
      const ctx = setup(tracks, NOW);
      await ctx.state.acquireLock(2027, 'otro', at(NOW).getTime(), LOCK_TTL_MS);
      const report = await syncPlaylists(ctx.deps, { dryRun: true });
      expect(report.skippedLocked).toEqual([]);
      expect(report.years[0]?.added).toHaveLength(3);
    });
  });
});
