import { readFile } from 'node:fs/promises';
import { findIncompleteFields } from '../tracks/completeness.ts';
import type { DailyTrack } from '../tracks/types.ts';

const MAX_REPORTED_ISSUES = 10;
const OPTIONAL_TEXT = ['coverUrl', 'description', 'spotifyArtistId'] as const;

/** El archivo de catálogo local no sirve. El mensaje enumera problemas, nunca el contenido. */
export class CatalogFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogFileError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Valida un catálogo local (`DailyTrack[]`): cada canción completa (mismos requisitos que una
 * canción preparada) y una sola por fecha. Descarta campos desconocidos.
 */
export function parseCatalog(raw: unknown): DailyTrack[] {
  if (!Array.isArray(raw)) throw new CatalogFileError('Catalog must be a JSON array of tracks');
  const issues: string[] = [];
  const tracks: DailyTrack[] = [];
  const dates = new Set<string>();

  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(`[${index}]: must be an object`);
      return;
    }
    const track = {
      date: item.date,
      title: item.title,
      artist: item.artist,
      album: item.album,
      releaseYear: item.releaseYear,
      spotifyTrackId: item.spotifyTrackId,
      spotifyUrl: item.spotifyUrl,
      selectionCriterion: item.selectionCriterion,
      createdAt: item.createdAt,
    } as unknown as DailyTrack;
    for (const field of OPTIONAL_TEXT) {
      const value = item[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        issues.push(`[${index}].${field}: must be a string`);
        continue;
      }
      track[field] = value;
    }
    const missing = findIncompleteFields(track);
    if (missing.length > 0) {
      issues.push(`[${index}]: incomplete or invalid fields (${missing.join(', ')})`);
      return;
    }
    if (dates.has(track.date)) {
      issues.push(`[${index}]: duplicate date ${track.date}`);
      return;
    }
    dates.add(track.date);
    tracks.push(track);
  });

  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_REPORTED_ISSUES).join('; ');
    const more =
      issues.length > MAX_REPORTED_ISSUES ? ` (+${issues.length - MAX_REPORTED_ISSUES} more)` : '';
    throw new CatalogFileError(`Catalog is invalid: ${shown}${more}`);
  }
  return tracks;
}

export async function loadCatalogFile(path: string): Promise<DailyTrack[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CatalogFileError(`Catalog file could not be read: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogFileError(`Catalog file is not valid JSON: ${path}`);
  }
  return parseCatalog(raw);
}
