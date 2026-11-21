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

/** Canción tal como la ve el frontend: sin los campos de uso interno. */
export type PublicTrack = Omit<DailyTrack, 'spotifyArtistId'>;

export function toPublicTrack({
  spotifyArtistId: _internal,
  ...publicTrack
}: DailyTrack): PublicTrack {
  return publicTrack;
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
