import { describe, expect, it } from 'vitest';
import { findDescriptionIssues } from '../../src/tracks/description.ts';
import { DESCRIPTION } from '../support/music.ts';

describe('findDescriptionIssues', () => {
  it('acepta una descripción breve de un párrafo', () => {
    expect(findDescriptionIssues(DESCRIPTION)).toEqual([]);
  });

  it.each([
    ['no es texto', 42, /string/],
    ['demasiado corta', 'Corta.', /at least/],
    ['demasiado larga', 'a'.repeat(501), /at most/],
    ['más de un párrafo', `${DESCRIPTION}\n\n${DESCRIPTION}`, /single paragraph/],
    ['con enlace', `${DESCRIPTION} https://example.com`, /links/],
    ['con www', `${DESCRIPTION} www.example.com`, /links/],
    ['con comillas rectas', `${DESCRIPTION} Dice "hola".`, /quotations/],
    ['con comillas angulares', `${DESCRIPTION} «Dice hola».`, /quotations/],
  ])('rechaza una descripción %s', (_name, value, message) => {
    expect(findDescriptionIssues(value).join(' ')).toMatch(message);
  });

  it('los años solo se permiten si fueron verificados', () => {
    const withYear = `${DESCRIPTION} Salió en 1983 y sigue vigente.`;
    expect(findDescriptionIssues(withYear)).toEqual([]);
    expect(findDescriptionIssues(withYear, { allowedYears: [1983] })).toEqual([]);
    expect(findDescriptionIssues(withYear, { allowedYears: [1990] })).toEqual([
      'mentions a year that was not verified',
    ]);
  });

  it('forbidDigits descarta fechas numéricas, años abreviados y de reedición', () => {
    for (const claim of [
      'El tema se estrenó el 13/07/91 durante una emisión radial.',
      'Salió en el 91 y sigue vigente.',
      'La reedición de 2015 lo volvió a poner en circulación.',
      'Fue número 1 durante semanas.',
    ]) {
      expect(findDescriptionIssues(`${DESCRIPTION} ${claim}`, { forbidDigits: true })).toHaveLength(
        1,
      );
    }
    expect(findDescriptionIssues(DESCRIPTION, { forbidDigits: true })).toEqual([]);
  });

  it('los meses se rechazan solo cuando se pide (afirmaciones de fecha sin verificar)', () => {
    const withMonth = `${DESCRIPTION} Se publicó en octubre.`;
    expect(findDescriptionIssues(withMonth)).toEqual([]);
    expect(findDescriptionIssues(withMonth, { forbidMonths: true })).toHaveLength(1);
    expect(
      findDescriptionIssues(`${DESCRIPTION} Habla de un March of time.`, { forbidMonths: true }),
    ).toEqual([]);
  });
});
