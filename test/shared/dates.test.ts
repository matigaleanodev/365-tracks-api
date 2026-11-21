import { describe, expect, it } from 'vitest';
import { addDays, getEditorialDate, isIsoDate } from '../../src/shared/dates.ts';

describe('isIsoDate', () => {
  it.each(['2027-01-01', '2028-02-29', '2027-12-31'])('acepta %s', (value) => {
    expect(isIsoDate(value)).toBe(true);
  });

  it.each([
    '2027-02-30',
    '2027-13-01',
    '2027-00-10',
    '2027-1-1',
    '2027-01-01T00:00:00Z',
    'today',
    '',
  ])('rechaza "%s"', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it('rechaza el 29 de febrero en año no bisiesto', () => {
    expect(isIsoDate('2027-02-29')).toBe(false);
  });
});

describe('getEditorialDate', () => {
  it('usa la fecha UTC, no la local', () => {
    expect(getEditorialDate(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
    expect(getEditorialDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
    // 22:30 en Buenos Aires (UTC-3) ya es el día siguiente en UTC.
    expect(getEditorialDate(new Date('2027-01-01T01:30:00Z'))).toBe('2027-01-01');
  });
});

describe('addDays', () => {
  it('cruza meses y años', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
