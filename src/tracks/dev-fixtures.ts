import { addDays, getEditorialDate } from '../shared/dates.ts';
import type { DailyTrack } from './types.ts';

/**
 * Canciones ficticias para desarrollo local. Los IDs y URLs no existen en Spotify.
 * Las fechas son relativas a `now` para que `/api/tracks/today` tenga datos.
 */
export function buildDevFixtures(now: Date, days = 5): DailyTrack[] {
  const today = getEditorialDate(now);
  return Array.from({ length: days }, (_, index) => {
    const number = index + 1;
    const track: DailyTrack = {
      date: addDays(today, -index),
      title: `Fixture Track ${number}`,
      artist: 'Fixture Artist',
      album: `Fixture Album ${number}`,
      releaseYear: 2000 + number,
      spotifyTrackId: `fixture-track-${number}`,
      spotifyUrl: `https://open.spotify.com/track/fixture-track-${number}`,
      selectionCriterion: 'development-fixture',
      // La API solo publica canciones completas: la descripción es obligatoria.
      description: `Descripción ficticia ${number} para desarrollo local, sin relación con ninguna canción real.`,
      createdAt: now.toISOString(),
    };
    if (number % 2 === 1) {
      track.coverUrl = `https://example.com/covers/fixture-${number}.jpg`;
    }
    return track;
  });
}
