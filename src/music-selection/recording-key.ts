import { coreTitle, normalizeArtist } from '../spotify/matching.ts';

/** Identidad de una grabación por título base + artista, independiente del ID de Spotify. */
export const recordingKeyOf = (title: string, artist: string): string =>
  `${coreTitle(title)}|${normalizeArtist(artist)}`;
