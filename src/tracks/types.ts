import type { IsoDate } from '../shared/dates.ts';

export interface DailyTrackRequired {
  /** Fecha editorial UTC; identifica de forma única a la canción. */
  date: IsoDate;
  title: string;
  artist: string;
  album: string;
  releaseYear: number;
  spotifyTrackId: string;
  spotifyUrl: string;
  selectionCriterion: string;
  /** Instante de creación, ISO 8601 en UTC. */
  createdAt: string;
}

export interface DailyTrackOptional {
  /** Spotify puede no devolver portada. */
  coverUrl?: string;
  /** Texto editorial; se genera en una etapa posterior. */
  description?: string;
}

export type DailyTrack = DailyTrackRequired & DailyTrackOptional;
