import { getEditorialDate, isIsoDate } from '../shared/dates.ts';
import { DISABLED_CRITERIA } from '../music-selection/criteria.ts';
import { findDescriptionIssues } from './description.ts';
import { PUBLICATION_START_DATE } from './publication.ts';
import type { DailyTrack } from './types.ts';

export type TrackInputResult = { ok: true; track: DailyTrack } | { ok: false; errors: string[] };

const REQUIRED_TEXT = ['title', 'artist', 'album', 'selectionCriterion'] as const;
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'date',
  'releaseYear',
  'spotifyTrackId',
  'spotifyUrl',
  'spotifyArtistId',
  'coverUrl',
  'description',
  ...REQUIRED_TEXT,
]);
const MAX_TEXT_LENGTH = 1000;
const MIN_RELEASE_YEAR = 1900;
/** Los IDs de Spotify son 22 caracteres base62. */
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/**
 * Valida los datos de una carga manual y arma la entidad. `createdAt` lo fija el sistema.
 * No toca red ni persistencia: sirve tanto para `--dry-run` como para la escritura real.
 */
export function parseTrackInput(raw: unknown, now: Date): TrackInputResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be a JSON object'] };
  }
  const input = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(field)) {
      errors.push(`${field}: unknown field`);
    }
  }

  const text = (field: string, required: boolean): string | undefined => {
    const value = input[field];
    if (value === undefined) {
      if (required) errors.push(`${field}: required`);
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${field}: must be a non-empty string`);
      return undefined;
    }
    if (value.trim().length > MAX_TEXT_LENGTH) {
      errors.push(`${field}: must be at most ${MAX_TEXT_LENGTH} characters`);
      return undefined;
    }
    return value.trim();
  };

  const date = text('date', true);
  if (date !== undefined) {
    if (!isIsoDate(date)) {
      errors.push('date: must be a valid calendar date in YYYY-MM-DD format');
    } else if (date < PUBLICATION_START_DATE) {
      errors.push(`date: must not be before the publication start (${PUBLICATION_START_DATE})`);
    }
  }

  const [title, artist, album, selectionCriterion] = REQUIRED_TEXT.map((field) =>
    text(field, true),
  );
  if (selectionCriterion !== undefined && DISABLED_CRITERIA.some((c) => c === selectionCriterion)) {
    errors.push('selectionCriterion: this criterion is disabled; use "manual" or another label');
  }
  // Sin descripción válida la canción no está preparada: también se exige en la carga manual.
  const description = text('description', true);
  if (description !== undefined) {
    for (const issue of findDescriptionIssues(description)) {
      errors.push(`description: ${issue}`);
    }
  }

  const maxYear = Number(getEditorialDate(now).slice(0, 4)) + 1;
  const releaseYear = input.releaseYear;
  if (releaseYear === undefined) {
    errors.push('releaseYear: required');
  } else if (
    typeof releaseYear !== 'number' ||
    !Number.isInteger(releaseYear) ||
    releaseYear < MIN_RELEASE_YEAR ||
    releaseYear > maxYear
  ) {
    errors.push(`releaseYear: must be an integer between ${MIN_RELEASE_YEAR} and ${maxYear}`);
  }

  const spotifyTrackId = text('spotifyTrackId', true);
  if (spotifyTrackId !== undefined && !SPOTIFY_ID_PATTERN.test(spotifyTrackId)) {
    errors.push('spotifyTrackId: must be a 22-character Spotify id');
  }

  const spotifyUrl = text('spotifyUrl', true);
  if (spotifyUrl !== undefined && spotifyTrackId !== undefined) {
    if (spotifyUrl !== `https://open.spotify.com/track/${spotifyTrackId}`) {
      errors.push('spotifyUrl: must be https://open.spotify.com/track/<spotifyTrackId>');
    }
  }

  const spotifyArtistId = text('spotifyArtistId', false);
  if (spotifyArtistId !== undefined && !SPOTIFY_ID_PATTERN.test(spotifyArtistId)) {
    errors.push('spotifyArtistId: must be a 22-character Spotify id');
  }

  const coverUrl = text('coverUrl', false);
  if (coverUrl !== undefined && !isHttpsUrl(coverUrl)) {
    errors.push('coverUrl: must be an https URL');
  }

  if (
    errors.length > 0 ||
    date === undefined ||
    title === undefined ||
    artist === undefined ||
    album === undefined ||
    selectionCriterion === undefined ||
    description === undefined ||
    spotifyTrackId === undefined ||
    spotifyUrl === undefined ||
    typeof releaseYear !== 'number'
  ) {
    return { ok: false, errors };
  }

  const track: DailyTrack = {
    date,
    title,
    artist,
    album,
    releaseYear,
    spotifyTrackId,
    spotifyUrl,
    selectionCriterion,
    description,
    createdAt: now.toISOString(),
  };
  if (coverUrl !== undefined) track.coverUrl = coverUrl;
  if (spotifyArtistId !== undefined) track.spotifyArtistId = spotifyArtistId;
  return { ok: true, track };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
