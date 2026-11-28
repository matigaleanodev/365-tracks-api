import { describe, expect, it } from 'vitest';
import {
  ARTIST_KEY_MAX_BYTES,
  artistControlKeys,
  artistNameKey,
} from '../../src/tracks/artist-key.ts';
import { artistControlKeys as reexported } from '../../src/tracks/dynamo-repository.ts';
import { removeTrack } from '../../src/tracks/maintenance.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';
import { preparedTrack } from '../support/music.ts';

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const longInputs = {
  ascii: 'a'.repeat(1000),
  japonés: 'あ'.repeat(1000),
  emoji: '🎸'.repeat(1000),
  acentos: 'é'.repeat(1000),
  mezcla: 'Ünïcode 音楽 🎵 '.repeat(100),
};

describe('artistNameKey', () => {
  it('conserva el formato de siempre si cabe en 256 bytes', () => {
    expect(artistNameKey('The Beatles')).toBe('name#beatles');
    expect(artistNameKey('Beatles')).toBe(artistNameKey('The Beatles'));
    const edge = 'a'.repeat(ARTIST_KEY_MAX_BYTES - 'name#'.length);
    expect(artistNameKey(edge)).toBe(`name#${edge}`);
    expect(artistNameKey(`${edge}a`)).toMatch(/^namehash#[0-9a-f]{64}$/);
  });

  it.each(Object.entries(longInputs))('acota por bytes UTF-8 un nombre de 1000 (%s)', (_, name) => {
    const [nameKey] = artistControlKeys({ artist: name, spotifyArtistId: '0'.repeat(22) });
    expect(bytes(nameKey!)).toBeLessThanOrEqual(1024);
    // Los emoji no sobreviven a la normalización: ese nombre usa la variante `raw:`.
    expect(nameKey).toMatch(/^namehash#(raw:)?[0-9a-f]{64}$/);
    expect(bytes(nameKey!)).toBeLessThanOrEqual(ARTIST_KEY_MAX_BYTES);
  });

  it('un nombre multibyte corto en caracteres pero largo en bytes también se resume', () => {
    const name = '音'.repeat(100); // 100 caracteres, 300 bytes
    expect(artistNameKey(name)).toMatch(/^namehash#/);
    expect(bytes(artistNameKey('音'.repeat(80)))).toBeLessThanOrEqual(ARTIST_KEY_MAX_BYTES);
  });

  it('dos nombres largos con el mismo prefijo de 300 bytes dan claves distintas', () => {
    const prefix = 'b'.repeat(300);
    expect(artistNameKey(`${prefix}1`)).not.toBe(artistNameKey(`${prefix}2`));
    const jp = 'あ'.repeat(100); // 300 bytes
    expect(artistNameKey(`${jp}い`)).not.toBe(artistNameKey(`${jp}う`));
  });

  it('un hash nunca puede coincidir con una clave name#', () => {
    const hashed = artistNameKey('c'.repeat(400));
    expect(hashed.startsWith('name#')).toBe(false);
    expect(artistNameKey('namehash#abc')).toBe('name#namehash abc');
  });

  it('los nombres solo de símbolos no colisionan entre sí', () => {
    const keys = ['!!!', '***', '???', '???!'].map(artistNameKey);
    expect(new Set(keys).size).toBe(4);
    for (const key of keys) expect(key).toMatch(/^namehash#raw:[0-9a-f]{64}$/);
    expect(artistNameKey('!!!')).toBe(artistNameKey(' !!! '));
  });

  it('la clave por ID de Spotify no cambia y se reexporta desde el repositorio', () => {
    const id = 'A1b2C3d4E5f6G7h8I9j0K1';
    expect(artistControlKeys({ artist: 'Band', spotifyArtistId: id })).toEqual([
      'name#band',
      `id#${id}`,
    ]);
    expect(reexported).toBe(artistControlKeys);
  });
});

describe('claves largas de punta a punta', () => {
  it('crear y dar de baja con artistas enormes usa claves acotadas y no colisiona', async () => {
    const dynamo = fakeDynamo();
    const prefix = '音'.repeat(150);
    const a = preparedTrack('2027-01-01', 1, { artist: `${prefix}A` });
    const b = preparedTrack('2027-01-02', 2, { artist: `${prefix}B` });
    expect(await dynamo.repository.create(a)).toBe('created');
    expect(await dynamo.repository.create(b)).toBe('created'); // no hay falso cooldown
    for (const [pk, key] of [...dynamo.items.keys()].map((k) => k.split('|') as [string, string])) {
      expect(bytes(key)).toBeLessThanOrEqual(1024);
      if (pk === 'ARTIST') expect(bytes(key)).toBeLessThanOrEqual(ARTIST_KEY_MAX_BYTES);
    }
    expect(
      await dynamo.repository.create(preparedTrack('2027-01-10', 3, { artist: a.artist })),
    ).toBe('artist-cooldown');

    expect(
      await removeTrack(dynamo.client, dynamo.table, '2027-01-01', {
        now: new Date('2026-12-01T00:00:00Z'),
      }),
    ).toBe('removed');
    const hashed = [...dynamo.items.keys()].filter((key) => key.startsWith('ARTIST|namehash#'));
    expect(hashed).toHaveLength(2);
    expect(
      dynamo.items.get(hashed.find((key) => key.includes(artistNameKey(a.artist)))!)?.dates,
    ).toEqual([]);
  });
});
