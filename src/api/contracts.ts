import type { DailyTrack } from '../tracks/types.ts';

export type ApiErrorCode =
  | 'INVALID_DATE'
  | 'INVALID_QUERY_PARAMETER'
  | 'TRACK_NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'INTERNAL_ERROR';

/** Cuerpo de toda respuesta de error. `requestId` permite correlacionar con CloudWatch. */
export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
  };
}

/** Campos públicos de una canción. */
export type PublicTrack = Pick<
  DailyTrack,
  | 'date'
  | 'title'
  | 'artist'
  | 'album'
  | 'releaseYear'
  | 'spotifyTrackId'
  | 'spotifyUrl'
  | 'selectionCriterion'
  | 'createdAt'
  | 'coverUrl'
  | 'description'
>;

export function toPublicTrack(track: DailyTrack): PublicTrack {
  return {
    date: track.date,
    title: track.title,
    artist: track.artist,
    album: track.album,
    releaseYear: track.releaseYear,
    spotifyTrackId: track.spotifyTrackId,
    spotifyUrl: track.spotifyUrl,
    selectionCriterion: track.selectionCriterion,
    createdAt: track.createdAt,
    coverUrl: track.coverUrl,
    description: track.description,
  };
}

/** GET /api/tracks/today y GET /api/tracks/:date */
export interface TrackResponse {
  data: PublicTrack;
}

/** GET /api/tracks */
export interface TrackListResponse {
  data: PublicTrack[];
  pagination: {
    limit: number;
    /** Valor opaco para pedir la página siguiente; null si no hay más. */
    nextCursor: string | null;
  };
}
