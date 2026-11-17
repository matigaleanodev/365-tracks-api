import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/errors.ts';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  decodeCursor,
  encodeCursor,
  parseListQuery,
} from '../../src/api/pagination.ts';

describe('cursor', () => {
  it('hace round-trip de una fecha', () => {
    expect(decodeCursor(encodeCursor('2027-03-15'))).toBe('2027-03-15');
  });

  it('rechaza valores que no son un cursor válido', () => {
    expect(decodeCursor('basura')).toBeNull();
    expect(decodeCursor(Buffer.from('2027-02-30').toString('base64url'))).toBeNull();
    expect(decodeCursor(`${encodeCursor('2027-03-15')}=`)).toBeNull();
  });
});

describe('parseListQuery', () => {
  it('aplica el límite por defecto', () => {
    expect(parseListQuery(undefined)).toEqual({ limit: DEFAULT_LIMIT });
    expect(parseListQuery({})).toEqual({ limit: DEFAULT_LIMIT });
  });

  it('lee limit y cursor', () => {
    expect(parseListQuery({ limit: '10', cursor: encodeCursor('2027-03-15') })).toEqual({
      limit: 10,
      before: '2027-03-15',
    });
  });

  it.each(['0', '-1', '1.5', 'abc', '', String(MAX_LIMIT + 1)])('rechaza limit "%s"', (limit) => {
    expect(() => parseListQuery({ limit })).toThrow(ApiError);
  });

  it('rechaza un cursor inválido', () => {
    expect(() => parseListQuery({ cursor: 'nope' })).toThrow(ApiError);
  });
});
