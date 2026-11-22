import type { IsoDate } from '../shared/dates.ts';
import type { TrackRepository } from './repository.ts';
import type { DailyTrack } from './types.ts';

const PAGE_SIZE = 100;

/**
 * Catálogo completo, de la fecha más reciente a la más antigua. Son pocos cientos de ítems
 * (uno por día), así que se lee paginando por el contrato del repositorio. Incluye fechas
 * futuras: es para uso interno, nunca para responder a la API.
 */
export async function readAllTracks(
  repository: Pick<TrackRepository, 'list'>,
): Promise<DailyTrack[]> {
  const tracks: DailyTrack[] = [];
  let before: IsoDate | undefined;
  for (;;) {
    const page = await repository.list({ limit: PAGE_SIZE, ...(before ? { before } : {}) });
    tracks.push(...page.items);
    const last = page.items.at(-1);
    if (!page.hasMore || !last) {
      return tracks;
    }
    before = last.date;
  }
}
