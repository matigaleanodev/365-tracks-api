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
  /**
   * Texto editorial. Opcional en el contrato HTTP por compatibilidad, pero una canción sin
   * descripción válida no está preparada (ver `completeness.ts`).
   */
  description?: string;
  /**
   * Artista principal en Spotify. Uso interno (rotación de artistas): la API no lo expone.
   * Las cargas manuales antiguas pueden no tenerlo; entonces se compara por nombre.
   */
  spotifyArtistId?: string;
}

export type DailyTrack = DailyTrackRequired & DailyTrackOptional;
