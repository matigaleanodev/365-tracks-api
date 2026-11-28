import { describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_SAMPLE_DATES,
  DEFAULT_REHEARSAL_NOW,
  RehearsalRefusedError,
  rehearsePlaylistSync,
  resolveTestPlaylist,
  sampleTrack,
} from '../../src/playlist/rehearsal.ts';
import { isEligibleForPlaylist } from '../../src/playlist/eligibility.ts';
import { parseTrackInput } from '../../src/tracks/track-input.ts';
import type { SpotifyPlaylistClient } from '../../src/spotify/playlist-client.ts';
import { preparedTrack, spotifyId } from '../support/music.ts';

const TEST_ID = 'testplaylist0000000001';

function fakeAccount(owner = 'owner-1', initial: string[] = []) {
  const items = [...initial];
  const client = {
    currentUserId: vi.fn(() => Promise.resolve('owner-1')),
    describe: vi.fn((id: string) =>
      Promise.resolve({
        id,
        url: `https://open.spotify.com/playlist/${id}`,
        name: 'Daywave ensayo',
        ownerId: owner,
        isPublic: true,
      }),
    ),
    findOwnedByName: vi.fn(),
    create: vi.fn(),
    listItems: vi.fn(() => Promise.resolve([...items])),
    addTracks: vi.fn((_id: string, ids: readonly string[], position?: number) => {
      items.splice(position ?? items.length, 0, ...ids);
      return Promise.resolve();
    }),
  };
  return { client: client as unknown as SpotifyPlaylistClient, items, spies: client };
}

const sample = [
  preparedTrack('2027-01-01', 1),
  preparedTrack('2027-01-02', 2),
  preparedTrack('2027-01-03', 3),
];
// Última elegible: 2027-01-02. La del 3 es "la del día" para alguna zona y no entra.
const NOW = new Date('2027-01-03T12:00:00Z');

describe('ensayo de la sincronización', () => {
  it('agrega solo lo elegible a la playlist de ensayo, en orden, y no duplica al repetir', async () => {
    const account = fakeAccount('owner-1', ['external000000000000001']);
    const report = await rehearsePlaylistSync({
      playlists: account.client,
      playlistId: TEST_ID,
      protectedPlaylistIds: ['annual0000000000000001'],
      sample,
      reservedTrackIds: [],
      now: NOW,
      dryRun: false,
    });

    expect(report.first.years[0]?.added).toEqual(['2027-01-01', '2027-01-02']);
    expect(report.second?.years).toEqual([]);
    expect(account.items).toEqual(['external000000000000001', spotifyId(1), spotifyId(2)]);
    expect(account.spies.create).not.toHaveBeenCalled();
    expect(account.spies.findOwnedByName).not.toHaveBeenCalled();
  });

  it('recupera una escritura parcial: completa lo que falta sin repetir lo ya agregado', async () => {
    const account = fakeAccount('owner-1', [spotifyId(1)]);
    const report = await rehearsePlaylistSync({
      playlists: account.client,
      playlistId: TEST_ID,
      protectedPlaylistIds: [],
      sample,
      reservedTrackIds: [],
      now: NOW,
      dryRun: false,
    });
    expect(report.first.years[0]).toMatchObject({ adopted: ['2027-01-01'], added: ['2027-01-02'] });
    expect(account.items).toEqual([spotifyId(1), spotifyId(2)]);
  });

  it('en dry-run no escribe nada', async () => {
    const account = fakeAccount();
    const report = await rehearsePlaylistSync({
      playlists: account.client,
      playlistId: TEST_ID,
      protectedPlaylistIds: [],
      sample,
      reservedTrackIds: [],
      now: NOW,
      dryRun: true,
    });
    expect(report.first.years[0]?.added).toEqual(['2027-01-01', '2027-01-02']);
    expect(report.second).toBeNull();
    expect(account.spies.addTracks).not.toHaveBeenCalled();
  });

  it('rechaza una playlist anual registrada o de otro titular sin escribir', async () => {
    const account = fakeAccount('someone-else');
    const run = (playlistId: string) =>
      rehearsePlaylistSync({
        playlists: account.client,
        playlistId,
        protectedPlaylistIds: ['annual0000000000000001'],
        sample,
        reservedTrackIds: [],
        now: NOW,
        dryRun: false,
      });
    await expect(run('annual0000000000000001')).rejects.toBeInstanceOf(RehearsalRefusedError);
    await expect(run(TEST_ID)).rejects.toThrow(/belongs to someone-else/);
    expect(account.spies.addTracks).not.toHaveBeenCalled();
  });

  it('rechaza una muestra con canciones del catálogo que todavía no son publicables', async () => {
    const account = fakeAccount();
    await expect(
      rehearsePlaylistSync({
        playlists: account.client,
        playlistId: TEST_ID,
        protectedPlaylistIds: [],
        sample,
        reservedTrackIds: [spotifyId(2)],
        now: NOW,
        dryRun: false,
      }),
    ).rejects.toThrow(/upcoming catalog tracks \(2027-01-02\)/);
    expect(account.spies.describe).not.toHaveBeenCalled();
    expect(account.spies.addTracks).not.toHaveBeenCalled();
  });
});

describe('playlist de ensayo y muestra integrada', () => {
  it('reutiliza Daywave - Test si existe y la crea pública solo al escribir', async () => {
    const account = fakeAccount();
    account.spies.findOwnedByName.mockResolvedValue(null);
    account.spies.create.mockResolvedValue({ id: TEST_ID, url: 'u' });
    await expect(resolveTestPlaylist(account.client, { dryRun: true })).resolves.toBeNull();
    expect(account.spies.create).not.toHaveBeenCalled();
    await expect(resolveTestPlaylist(account.client, { dryRun: false })).resolves.toEqual({
      id: TEST_ID,
      created: true,
    });
    expect(account.spies.findOwnedByName).toHaveBeenCalledWith('Daywave - Test');
    expect(account.spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Daywave - Test', isPublic: true }),
    );
    account.spies.findOwnedByName.mockResolvedValue({ id: 'existing00000000000001', url: 'u' });
    await expect(resolveTestPlaylist(account.client, { dryRun: false })).resolves.toEqual({
      id: 'existing00000000000001',
      created: false,
    });
  });

  it('rechaza un ID cuya playlist se llama como una anual, aunque no esté registrada', async () => {
    const account = fakeAccount();
    account.spies.describe.mockResolvedValueOnce({
      id: TEST_ID,
      url: 'u',
      name: 'Daywave  2027 (copia)',
      ownerId: 'owner-1',
      isPublic: true,
    });
    await expect(
      rehearsePlaylistSync({
        playlists: account.client,
        playlistId: TEST_ID,
        protectedPlaylistIds: [],
        reservedTrackIds: [],
        sample,
        now: NOW,
        dryRun: false,
      }),
    ).rejects.toThrow(RehearsalRefusedError);
    expect(account.spies.addTracks).not.toHaveBeenCalled();
  });

  it('nunca usa un nombre de playlist anual', async () => {
    const account = fakeAccount();
    await expect(
      resolveTestPlaylist(account.client, { name: 'Daywave 2027', dryRun: false }),
    ).rejects.toThrow(RehearsalRefusedError);
    expect(account.spies.findOwnedByName).not.toHaveBeenCalled();
  });

  it('la muestra integrada es válida y el reloj por defecto deja fuera la última fecha', () => {
    const now = new Date('2026-11-28T00:00:00Z');
    const track = sampleTrack(
      {
        id: spotifyId(9),
        title: 'Song',
        artist: 'Band',
        artistId: spotifyId(8),
        artists: [],
        album: 'Album',
        releaseYear: 1991,
        releaseDate: '1991',
        releaseDatePrecision: 'year',
        url: `https://open.spotify.com/track/${spotifyId(9)}`,
      },
      '2027-01-01',
      now,
    );
    const input = Object.fromEntries(Object.entries(track).filter(([key]) => key !== 'createdAt'));
    expect(parseTrackInput(input, now)).toEqual({ ok: true, track });
    const clock = new Date(DEFAULT_REHEARSAL_NOW);
    expect(BUILT_IN_SAMPLE_DATES.map((date) => isEligibleForPlaylist(date, clock))).toEqual([
      true,
      true,
      false,
    ]);
  });
});
