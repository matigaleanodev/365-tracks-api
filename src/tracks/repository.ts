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

export type CreateTrackResult = 'created' | 'already-exists';

export interface TrackRepository {
  getByDate(date: IsoDate): Promise<DailyTrack | null>;
  list(options: ListTracksOptions): Promise<TrackPage>;
  /** Escritura condicional y atómica: nunca sobrescribe una fecha ya existente. */
  create(track: DailyTrack): Promise<CreateTrackResult>;
}
