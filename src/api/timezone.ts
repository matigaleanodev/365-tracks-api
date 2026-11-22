import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../shared/dates.ts';
import { invalidQueryParameter } from './errors.ts';

/**
 * Zona horaria solicitada por el visitante (`timezone`, IANA). Sin parámetro rige UTC por
 * compatibilidad. Solo decide qué fecha local es "hoy": el reloj siempre es el del servidor.
 */
export function parseTimeZone(
  params: Record<string, string | undefined> | null | undefined,
): string {
  const raw = params?.timezone;
  if (raw === undefined) {
    return DEFAULT_TIME_ZONE;
  }
  if (!isValidTimeZone(raw)) {
    throw invalidQueryParameter(
      'timezone',
      'must be a valid IANA time zone, e.g. America/Argentina/Buenos_Aires',
    );
  }
  return raw;
}
