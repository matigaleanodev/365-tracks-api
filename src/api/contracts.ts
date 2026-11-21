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

/** GET /api/tracks/today y GET /api/tracks/:date */
export interface TrackResponse {
  data: DailyTrack;
}

/** GET /api/tracks */
export interface TrackListResponse {
  data: DailyTrack[];
  pagination: {
    limit: number;
    /** Valor opaco para pedir la página siguiente; null si no hay más. */
    nextCursor: string | null;
  };
}
