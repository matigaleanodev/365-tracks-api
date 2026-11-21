import type { IsoDate } from '../shared/dates.ts';
import type { DailyTrack } from './types.ts';

export interface ListTracksOptions {
  limit: number;
  /** Solo devuelve canciones con fecha estrictamente anterior (exclusivo). */
  before?: IsoDate;
}

export interface TrackPage {
  /** Ordenadas de la más reciente a la más antigua. */
  items: DailyTrack[];
  hasMore: boolean;
}

/** Regla editorial violada al escribir: la fecha no se ocupa y la canción debe reemplazarse. */
export type TrackConflict = 'duplicate-track' | 'duplicate-recording' | 'artist-cooldown';

export type CreateTrackResult = 'created' | 'already-exists' | TrackConflict;

export interface TrackRepository {
  getByDate(date: IsoDate): Promise<DailyTrack | null>;
  list(options: ListTracksOptions): Promise<TrackPage>;
  /**
   * Escritura condicional y atómica: nunca sobrescribe una fecha ya existente y nunca guarda la
   * misma grabación (ID de Spotify o título + artista) en dos fechas ni el mismo artista a menos
   * de 60 días de otra fecha. Es la última garantía: la selección editorial valida antes, pero una
   * ejecución concurrente puede haber ocupado el lugar entre la lectura y la escritura.
   */
  create(track: DailyTrack): Promise<CreateTrackResult>;
}
