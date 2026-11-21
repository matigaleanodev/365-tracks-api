import type { TrackRepository } from './repository.ts';
import { parseTrackInput } from './track-input.ts';
import type { DailyTrack } from './types.ts';

export type ManualLoadResult =
  | { status: 'invalid'; errors: string[] }
  | { status: 'valid'; track: DailyTrack }
  | { status: 'created'; track: DailyTrack }
  | { status: 'already-exists'; track: DailyTrack };

export interface ManualLoadOptions {
  raw: unknown;
  now: Date;
  /** Sin repositorio solo valida: es la ruta de `--dry-run`, que nunca toca AWS. */
  repository?: TrackRepository;
}

/** Carga manual de una canción: valida y, con repositorio, escribe sin sobrescribir la fecha. */
export async function loadTrackManually({
  raw,
  now,
  repository,
}: ManualLoadOptions): Promise<ManualLoadResult> {
  const parsed = parseTrackInput(raw, now);
  if (!parsed.ok) {
    return { status: 'invalid', errors: parsed.errors };
  }
  if (!repository) {
    return { status: 'valid', track: parsed.track };
  }
  const result = await repository.create(parsed.track);
  if (result === 'created') {
    return { status: 'created', track: parsed.track };
  }
  // Se devuelve el registro vigente, no el recibido: el recibido no se escribió.
  const existing = await repository.getByDate(parsed.track.date);
  if (!existing) {
    throw new Error(`Track for ${parsed.track.date} reported as existing but could not be read`);
  }
  return { status: 'already-exists', track: existing };
}
