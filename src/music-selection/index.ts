import type { IsoDate } from '../shared/dates.ts';
import { NotImplementedError } from '../shared/errors.ts';

/** Resultado de la curaduría editorial; Spotify aporta después los metadatos. */
export interface TrackSelection {
  spotifyTrackId: string;
  selectionCriterion: string;
  /** Obligatoria: sin descripción válida la canción no se considera preparada. */
  description: string;
}

export interface MusicSelector {
  select(date: IsoDate): Promise<TrackSelection>;
}

export const notImplementedMusicSelector: MusicSelector = {
  select: () => Promise.reject(new NotImplementedError('Music selection')),
};

export {
  createEditorialSelector,
  SelectionFailedError,
  type EditorialSelectorOptions,
} from './selector.ts';
