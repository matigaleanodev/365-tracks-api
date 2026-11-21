import type { IsoDate } from '../shared/dates.ts';
import type {
  CreateTrackResult,
  ListTracksOptions,
  TrackPage,
  TrackRepository,
} from './repository.ts';
import type { DailyTrack } from './types.ts';

/**
 * Repositorio en memoria para fixtures de desarrollo y tests.
 * No es persistencia: se pierde con cada instancia de Lambda.
 */
export class InMemoryTrackRepository implements TrackRepository {
  readonly #tracks = new Map<IsoDate, DailyTrack>();

  constructor(initial: readonly DailyTrack[] = []) {
    for (const track of initial) {
      this.#tracks.set(track.date, track);
    }
  }

  getByDate(date: IsoDate): Promise<DailyTrack | null> {
    return Promise.resolve(this.#tracks.get(date) ?? null);
  }

  list({ limit, before }: ListTracksOptions): Promise<TrackPage> {
    const candidates = [...this.#tracks.values()]
      .filter((track) => before === undefined || track.date < before)
      .sort((a, b) => b.date.localeCompare(a.date));
    return Promise.resolve({
      items: candidates.slice(0, limit),
      hasMore: candidates.length > limit,
    });
  }

  create(track: DailyTrack): Promise<CreateTrackResult> {
    if (this.#tracks.has(track.date)) {
      return Promise.resolve('already-exists');
    }
    this.#tracks.set(track.date, track);
    return Promise.resolve('created');
  }
}
