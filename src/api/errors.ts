import type { ApiErrorCode } from './contracts.ts';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;

  constructor(code: ApiErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const invalidDate = () =>
  new ApiError('INVALID_DATE', 400, 'date must be a valid calendar date in YYYY-MM-DD format');

export const invalidQueryParameter = (parameter: string, message: string) =>
  new ApiError('INVALID_QUERY_PARAMETER', 400, `${parameter}: ${message}`);

export const trackNotFound = (date: string) =>
  new ApiError('TRACK_NOT_FOUND', 404, `No track published for ${date}`);

export const routeNotFound = () => new ApiError('ROUTE_NOT_FOUND', 404, 'Route does not exist');
