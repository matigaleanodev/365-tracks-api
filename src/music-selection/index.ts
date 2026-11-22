import type { IsoDate } from '../shared/dates.ts';
import { NotImplementedError } from '../shared/errors.ts';
import type { TimeBudget } from '../shared/time-budget.ts';

/** Resultado de la curaduría editorial; Spotify aporta después los metadatos. */
export interface TrackSelection {
  spotifyTrackId: string;
  selectionCriterion: string;
  /** Obligatoria: sin descripción válida la canción no se considera preparada. */
  description: string;
}

export interface SelectOptions {
  /** Presupuesto de la invocación: si no alcanza lanza `TimeBudgetExhaustedError`, nunca devuelve algo parcial. */
  budget?: TimeBudget;
}

export interface MusicSelector {
  select(date: IsoDate, options?: SelectOptions): Promise<TrackSelection>;
}

export const notImplementedMusicSelector: MusicSelector = {
  select: () => Promise.reject(new NotImplementedError('Music selection')),
};

export {
  createEditorialSelector,
  SelectionFailedError,
  type EditorialSelectorOptions,
  type SelectionEvaluationEvent,
} from './selector.ts';
