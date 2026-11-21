import { isIsoDate } from '../shared/dates.ts';
import { findDescriptionIssues } from './description.ts';
import type { DailyTrack } from './types.ts';

const REQUIRED_TEXT = [
  'title',
  'artist',
  'album',
  'spotifyTrackId',
  'spotifyUrl',
  'selectionCriterion',
  'createdAt',
] as const;

/**
 * Campos obligatorios ausentes o inválidos. Una canción solo está preparada con todos ellos y con
 * una descripción editorial válida. `coverUrl` es opcional (Spotify puede no devolver portada).
 */
export function findIncompleteFields(track: DailyTrack): string[] {
  const missing: string[] = [];
  if (!isIsoDate(track.date)) {
    missing.push('date');
  }
  for (const field of REQUIRED_TEXT) {
    const value: unknown = track[field];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(field);
    }
  }
  if (!Number.isInteger(track.releaseYear)) {
    missing.push('releaseYear');
  }
  if (findDescriptionIssues(track.description).length > 0) {
    missing.push('description');
  }
  return missing;
}

export class IncompleteTrackError extends Error {
  constructor(date: string, fields: string[]) {
    super(`Track for ${date} is incomplete (${fields.join(', ')}); nothing was written`);
    this.name = 'IncompleteTrackError';
  }
}
