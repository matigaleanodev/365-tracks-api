import type { SpotifyClient, SpotifyTrack } from '../../src/spotify/index.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';

/** Descripción editorial válida (una frase, sin años, comillas ni URLs). */
export const DESCRIPTION =
  'Una canción de guitarras luminosas y base rítmica directa, pensada para arrancar el día.';

/** ID de Spotify sintético pero con formato válido (22 caracteres alfanuméricos). */
export const spotifyId = (n: number) => `track${String(n).padStart(17, '0')}`;

export const spotifyUrl = (id: string) => `https://open.spotify.com/track/${id}`;

/** Canción de catálogo completa y válida para la fecha indicada. */
export function preparedTrack(
  date: string,
  n: number,
  overrides: Partial<DailyTrack> = {},
): DailyTrack {
  const id = spotifyId(n);
  return {
    date,
    title: `Title ${n}`,
    artist: `Artist ${n}`,
    album: 'Album',
    releaseYear: 1990,
    spotifyTrackId: id,
    spotifyUrl: spotifyUrl(id),
    selectionCriterion: 'manual',
    description: DESCRIPTION,
    createdAt: '2026-11-21T13:00:00.000Z',
    ...overrides,
  };
}

/** Metadatos de Spotify completos y válidos. */
export function spotifyTrack(id: string, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    artistId: 'artist00000000000000AA',
    artists: [{ id: 'artist00000000000000AA', name: 'Artist' }],
    album: 'Album',
    releaseYear: 1999,
    releaseDate: '1999-05-04',
    releaseDatePrecision: 'day',
    url: spotifyUrl(id),
    ...overrides,
  };
}

/** Artista propio de cada ID: los catálogos de prueba no pueden repetir artista dentro de 60 días. */
export const ownArtist = (id: string): Partial<SpotifyTrack> => {
  const artistId = `a${id.slice(-21)}`;
  return { artist: `Artist ${id}`, artistId, artists: [{ id: artistId, name: `Artist ${id}` }] };
};

/** Cliente de Spotify falso: `getTrack` devuelve metadatos válidos; `searchTracks`, nada. */
export function fakeSpotify(overrides: Partial<SpotifyClient> = {}): SpotifyClient {
  return {
    getTrack: (id) => Promise.resolve(spotifyTrack(id)),
    searchTracks: () => Promise.resolve([]),
    ...overrides,
  };
}
