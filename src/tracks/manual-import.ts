import { readAllTracks } from './read-all.ts';
import type { TrackRepository } from './repository.ts';
import { parseTrackInput } from './track-input.ts';
import type { DailyTrack } from './types.ts';

export const MAX_IMPORT_RECORDS = 366;

export type ImportRecordStatus =
  | 'valid' // dry-run: pasó todas las validaciones del archivo
  | 'created'
  | 'already-exists' // la fecha ya tenía canción: no se toca
  | 'invalid' // error propio del registro
  | 'conflict' // choca con otro registro o con el catálogo guardado
  | 'not-written'; // válido, pero el lote se abortó antes de escribir

export interface ImportRecordResult {
  /** Posición (desde 1) en el archivo. */
  position: number;
  date: string | null;
  status: ImportRecordStatus;
  errors: string[];
}

export interface ImportReport {
  /** false si el lote se abortó: en ese caso no se escribió nada. */
  ok: boolean;
  records: ImportRecordResult[];
  /** Errores del archivo completo (no de un registro). */
  errors: string[];
}

export interface ImportOptions {
  raw: unknown;
  now: Date;
  /** Sin repositorio solo valida el archivo: es la ruta de `--dry-run`, que nunca toca AWS. */
  repository?: TrackRepository;
}

function recordDate(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const { date } = raw as Record<string, unknown>;
    return typeof date === 'string' ? date : null;
  }
  return null;
}

/**
 * Importa varias canciones. Todo se valida antes de escribir: un registro inválido, una fecha o
 * un ID de Spotify repetidos en el archivo, o un ID ya usado en otra fecha guardada abortan el
 * lote completo sin escribir nada. Las fechas que ya tienen canción se informan y no se
 * sobrescriben, así que repetir la importación es seguro.
 */
export async function importTracks({ raw, now, repository }: ImportOptions): Promise<ImportReport> {
  if (!Array.isArray(raw)) {
    return { ok: false, records: [], errors: ['input must be a JSON array of tracks'] };
  }
  if (raw.length === 0 || raw.length > MAX_IMPORT_RECORDS) {
    return {
      ok: false,
      records: [],
      errors: [`input must contain between 1 and ${MAX_IMPORT_RECORDS} tracks`],
    };
  }

  const records: ImportRecordResult[] = raw.map((item, index) => ({
    position: index + 1,
    date: recordDate(item),
    status: 'valid',
    errors: [],
  }));
  const tracks = new Map<number, DailyTrack>();

  raw.forEach((item, index) => {
    const parsed = parseTrackInput(item, now);
    const record = records[index]!;
    if (parsed.ok) {
      tracks.set(index, parsed.track);
    } else {
      record.status = 'invalid';
      record.errors = parsed.errors;
    }
  });

  const flagDuplicates = (
    keyOf: (track: DailyTrack) => string,
    describe: (key: string) => string,
  ) => {
    const seen = new Map<string, number[]>();
    for (const [index, track] of tracks) {
      seen.set(keyOf(track), [...(seen.get(keyOf(track)) ?? []), index]);
    }
    for (const [key, indexes] of seen) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        const record = records[index]!;
        record.status = 'conflict';
        record.errors.push(`${describe(key)} (records ${indexes.map((i) => i + 1).join(', ')})`);
      }
    }
  };
  flagDuplicates(
    (track) => track.date,
    (date) => `date ${date} appears more than once in the file`,
  );
  flagDuplicates(
    (track) => track.spotifyTrackId,
    (id) => `spotifyTrackId ${id} appears more than once in the file`,
  );

  const abort = (): ImportReport => ({
    ok: false,
    errors: [],
    records: records.map((record) =>
      record.status === 'valid' ? { ...record, status: 'not-written' as const } : record,
    ),
  });
  if (records.some((record) => record.status !== 'valid')) {
    return abort();
  }
  if (!repository) {
    return { ok: true, records, errors: [] };
  }

  // Contra el catálogo guardado: una canción no puede repetirse en otra fecha.
  const stored = await readAllTracks(repository);
  const dateById = new Map(stored.map((track) => [track.spotifyTrackId, track.date]));
  const storedDates = new Set(stored.map((track) => track.date));
  for (const [index, track] of tracks) {
    const record = records[index]!;
    if (storedDates.has(track.date)) {
      record.status = 'already-exists';
      continue;
    }
    const usedOn = dateById.get(track.spotifyTrackId);
    if (usedOn !== undefined) {
      record.status = 'conflict';
      record.errors.push(`spotifyTrackId ${track.spotifyTrackId} is already used on ${usedOn}`);
    }
  }
  if (records.some((record) => record.status === 'conflict')) {
    return abort();
  }

  for (const [index, track] of tracks) {
    const record = records[index]!;
    if (record.status === 'already-exists') continue;
    // La escritura es condicional: una carrera con otra ejecución nunca pisa la fecha.
    record.status = (await repository.create(track)) === 'created' ? 'created' : 'already-exists';
  }
  return { ok: true, records, errors: [] };
}
