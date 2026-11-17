import { isIsoDate, type IsoDate } from '../shared/dates.ts';
import { invalidQueryParameter } from './errors.ts';

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export interface ListQuery {
  limit: number;
  before?: IsoDate;
}

/** El cursor codifica la última fecha entregada; la página siguiente es estrictamente anterior. */
export function encodeCursor(lastDate: IsoDate): string {
  return Buffer.from(lastDate, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): IsoDate | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  return isIsoDate(decoded) && encodeCursor(decoded) === cursor ? decoded : null;
}

export function parseListQuery(
  params: Record<string, string | undefined> | null | undefined,
): ListQuery {
  const rawLimit = params?.limit;
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw invalidQueryParameter('limit', `must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }

  const rawCursor = params?.cursor;
  if (rawCursor === undefined) {
    return { limit };
  }
  const before = decodeCursor(rawCursor);
  if (before === null) {
    throw invalidQueryParameter('cursor', 'is not a valid cursor');
  }
  return { limit, before };
}
