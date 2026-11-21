import { describe, expect, it } from 'vitest';
import {
  addDays,
  getEditorialDate,
  getLocalDate,
  isIsoDate,
  isValidTimeZone,
} from '../../src/shared/dates.ts';

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

describe('getLocalDate', () => {
  const at = (iso: string, zone: string) => getLocalDate(new Date(iso), zone);

  it('el 1 de enero de 2027 empieza a las 00:00 locales en cada zona', () => {
    // Argentina UTC-3, España UTC+1, Japón UTC+9.
    expect(at('2027-01-01T02:59:59Z', 'America/Argentina/Buenos_Aires')).toBe('2026-12-31');
    expect(at('2027-01-01T03:00:00Z', 'America/Argentina/Buenos_Aires')).toBe('2027-01-01');
    expect(at('2026-12-31T22:59:59Z', 'Europe/Madrid')).toBe('2026-12-31');
    expect(at('2026-12-31T23:00:00Z', 'Europe/Madrid')).toBe('2027-01-01');
    expect(at('2026-12-31T14:59:59Z', 'Asia/Tokyo')).toBe('2026-12-31');
    expect(at('2026-12-31T15:00:00Z', 'Asia/Tokyo')).toBe('2027-01-01');
  });

  it('UTC coincide con la fecha editorial', () => {
    const now = new Date('2027-06-15T23:59:59Z');
    expect(getLocalDate(now, 'UTC')).toBe(getEditorialDate(now));
  });

  it('zonas extremas: UTC+14 va un día adelante y UTC-12 un día atrás', () => {
    expect(at('2027-01-01T09:59:59Z', 'Pacific/Kiritimati')).toBe('2027-01-01');
    expect(at('2027-01-01T10:00:00Z', 'Pacific/Kiritimati')).toBe('2027-01-02');
    expect(at('2027-01-01T11:59:59Z', 'Etc/GMT+12')).toBe('2026-12-31');
    expect(at('2027-01-01T12:00:00Z', 'Etc/GMT+12')).toBe('2027-01-01');
  });

  it('zonas con desfase fraccionario', () => {
    expect(at('2027-01-01T18:29:59Z', 'Asia/Kolkata')).toBe('2027-01-01');
    expect(at('2027-01-01T18:30:00Z', 'Asia/Kolkata')).toBe('2027-01-02');
    expect(at('2027-01-01T10:14:59Z', 'Pacific/Chatham')).toBe('2027-01-01');
    expect(at('2027-01-01T10:15:00Z', 'Pacific/Chatham')).toBe('2027-01-02');
  });

  it('respeta el cambio a horario de verano y de invierno', () => {
    // Madrid: verano termina el 2027-10-31 a las 01:00Z (CEST UTC+2 → CET UTC+1).
    expect(at('2027-10-30T21:59:59Z', 'Europe/Madrid')).toBe('2027-10-30');
    expect(at('2027-10-30T22:00:00Z', 'Europe/Madrid')).toBe('2027-10-31');
    expect(at('2027-10-31T22:59:59Z', 'Europe/Madrid')).toBe('2027-10-31');
    expect(at('2027-10-31T23:00:00Z', 'Europe/Madrid')).toBe('2027-11-01');
    // Madrid: verano empieza el 2027-03-28 a las 01:00Z (CET → CEST).
    expect(at('2027-03-27T22:59:59Z', 'Europe/Madrid')).toBe('2027-03-27');
    expect(at('2027-03-27T23:00:00Z', 'Europe/Madrid')).toBe('2027-03-28');
    expect(at('2027-03-28T21:59:59Z', 'Europe/Madrid')).toBe('2027-03-28');
    expect(at('2027-03-28T22:00:00Z', 'Europe/Madrid')).toBe('2027-03-29');
    // Nueva York: 2027-03-14 07:00Z salta de 02:00 a 03:00 locales; la fecha no se altera.
    expect(at('2027-03-14T04:59:59Z', 'America/New_York')).toBe('2027-03-13');
    expect(at('2027-03-14T05:00:00Z', 'America/New_York')).toBe('2027-03-14');
    expect(at('2027-03-15T03:59:59Z', 'America/New_York')).toBe('2027-03-14');
    expect(at('2027-03-15T04:00:00Z', 'America/New_York')).toBe('2027-03-15');
  });

  it('hemisferio sur: Sídney cambia de huso en octubre', () => {
    // Sídney: horario de verano empieza el 2027-10-03 a las 16:00Z del día anterior (UTC+10 → +11).
    expect(at('2027-10-02T13:59:59Z', 'Australia/Sydney')).toBe('2027-10-02');
    expect(at('2027-10-02T14:00:00Z', 'Australia/Sydney')).toBe('2027-10-03');
    expect(at('2027-10-03T12:59:59Z', 'Australia/Sydney')).toBe('2027-10-03');
    expect(at('2027-10-03T13:00:00Z', 'Australia/Sydney')).toBe('2027-10-04');
  });
});

describe('isValidTimeZone', () => {
  it.each([
    'UTC',
    'America/Argentina/Buenos_Aires',
    'Europe/Madrid',
    'Asia/Tokyo',
    'Pacific/Kiritimati',
    'Etc/GMT+12',
  ])('acepta %s', (value) => {
    expect(isValidTimeZone(value)).toBe(true);
  });

  it.each([
    '',
    'Mars/Olympus_Mons',
    'Nowhere',
    '+03:00',
    'UTC+3',
    '../etc/passwd',
    'America/Argentina/Buenos_Aires/Extra/Deep',
    `America/${'a'.repeat(80)}`,
    'Europe/Madrid; DROP',
  ])('rechaza "%s"', (value) => {
    expect(isValidTimeZone(value)).toBe(false);
  });
});

describe('addDays', () => {
  it('cruza meses y años', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
