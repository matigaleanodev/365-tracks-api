import type { IsoDate } from '../shared/dates.ts';
import { NotImplementedError } from '../shared/errors.ts';

/** Resultado de la curaduría editorial; Spotify aporta después los metadatos. */
export interface TrackSelection {
  spotifyTrackId: string;
  selectionCriterion: string;
  description?: string;
}

export interface MusicSelector {
  select(date: IsoDate): Promise<TrackSelection>;
}

export const notImplementedMusicSelector: MusicSelector = {
  select: () => Promise.reject(new NotImplementedError('Music selection')),
};
