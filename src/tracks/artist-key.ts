import { createHash } from 'node:crypto';
import { normalizeArtist } from '../spotify/matching.ts';
import type { DailyTrack } from './types.ts';

/** Tope de bytes UTF-8 de una clave `name#...` (la clave de ordenación admite 1024: hay margen). */
export const ARTIST_KEY_MAX_BYTES = 256;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Identidad del artista por nombre, única para todos los módulos (reglas, repositorios, importación
 * y claves de control): el nombre normalizado y, si queda vacío (solo símbolos), un resumen del
 * original para que "!!!" y "***" no se confundan. El texto normalizado nunca contiene ':', así
 * que `raw:` no puede chocar con una identidad normal.
 * "The Beatles" y "Beatles" siguen siendo el mismo artista (normalizeArtist, intencional).
 */
export function artistIdentity(artist: string): string {
  const normalized = normalizeArtist(artist);
  return normalized !== ''
    ? normalized
    : `raw:${sha256(artist.normalize('NFC').trim().toLowerCase())}`;
}

/**
 * Clave de control del nombre de artista, acotada por bytes UTF-8 (no por caracteres):
 * - `name#<normalizado>` si la clave completa cabe en ARTIST_KEY_MAX_BYTES.
 * - `namehash#<sha256 del normalizado completo>` si no cabe: el prefijo distinto impide chocar con
 *   una clave `name#` y el hash cubre todo el nombre, así que no hay colisión por truncado.
 * - `namehash#raw:<sha256>` para nombres que normalizan a vacío (ver `artistIdentity`).
 */
export function artistNameKey(artist: string): string {
  const identity = artistIdentity(artist);
  if (identity.startsWith('raw:')) return `namehash#${identity}`;
  const key = `name#${identity}`;
  return Buffer.byteLength(key, 'utf8') <= ARTIST_KEY_MAX_BYTES
    ? key
    : `namehash#${sha256(identity)}`;
}

/** Claves de control del artista: nombre y, si existe, ID de Spotify (`id#<22 base62>`). */
export const artistControlKeys = (track: Pick<DailyTrack, 'artist' | 'spotifyArtistId'>) => [
  artistNameKey(track.artist),
  ...(track.spotifyArtistId ? [`id#${track.spotifyArtistId}`] : []),
];
