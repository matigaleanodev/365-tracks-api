import { describe, expect, it } from 'vitest';
import { parseTrackInput } from '../../src/tracks/track-input.ts';
import { DESCRIPTION } from '../support/music.ts';

const NOW = new Date('2026-11-21T13:00:00Z');

const valid = () => ({
  date: '2027-01-01',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  releaseYear: 1991,
  spotifyTrackId: '4uLU6hMCjMI75M1A2tKUQC',
  spotifyUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
  selectionCriterion: 'manual',
  description: DESCRIPTION,
});

describe('parseTrackInput', () => {
  it('arma la entidad sin portada ni artista y fija createdAt', () => {
    const result = parseTrackInput(valid(), NOW);
    expect(result).toEqual({
      ok: true,
      track: { ...valid(), createdAt: '2026-11-21T13:00:00.000Z' },
    });
    expect(result.ok && result.track).not.toHaveProperty('coverUrl');
    expect(result.ok && result.track).not.toHaveProperty('spotifyArtistId');
  });

  it('acepta campos opcionales y recorta espacios', () => {
    const result = parseTrackInput(
      {
        ...valid(),
        title: '  Song  ',
        coverUrl: 'https://i.scdn.co/image/x',
        description: `  ${DESCRIPTION}  `,
        spotifyArtistId: 'artist00000000000000AA',
      },
      NOW,
    );
    expect(result.ok && result.track).toMatchObject({
      title: 'Song',
      coverUrl: 'https://i.scdn.co/image/x',
      description: DESCRIPTION,
      spotifyArtistId: 'artist00000000000000AA',
    });
  });

  it('rechaza createdAt recibido: lo decide el sistema', () => {
    const result = parseTrackInput({ ...valid(), createdAt: '2020-01-01T00:00:00Z' }, NOW);
    expect(result).toEqual({ ok: false, errors: ['createdAt: unknown field'] });
  });

  it.each([
    ['falta un campo obligatorio', { ...valid(), title: undefined }, 'title: required'],
    ['texto vacío', { ...valid(), artist: '  ' }, 'artist: must be a non-empty string'],
    ['texto con otro tipo', { ...valid(), album: 7 }, 'album: must be a non-empty string'],
    ['fecha con formato inválido', { ...valid(), date: '1/1/2027' }, /^date: must be a valid/],
    ['fecha inexistente', { ...valid(), date: '2027-02-30' }, /^date: must be a valid/],
    ['fecha previa al lanzamiento', { ...valid(), date: '2026-12-31' }, /publication start/],
    ['año no entero', { ...valid(), releaseYear: 1991.5 }, /^releaseYear/],
    ['año como texto', { ...valid(), releaseYear: '1991' }, /^releaseYear/],
    ['año demasiado futuro', { ...valid(), releaseYear: 2028 }, /^releaseYear/],
    ['id de Spotify inválido', { ...valid(), spotifyTrackId: 'abc' }, /^spotifyTrackId/],
    [
      'url que no corresponde al id',
      { ...valid(), spotifyUrl: 'https://open.spotify.com/track/x' },
      /^spotifyUrl/,
    ],
    ['sin descripción', { ...valid(), description: undefined }, /^description/],
    ['descripción corta', { ...valid(), description: 'Muy corta.' }, /^description/],
    [
      'descripción con comillas',
      { ...valid(), description: `${DESCRIPTION} "cita"` },
      /^description/,
    ],
    [
      'descripción con URL',
      { ...valid(), description: `${DESCRIPTION} https://x.example` },
      /^description/,
    ],
    ['artista con ID inválido', { ...valid(), spotifyArtistId: 'corto' }, /^spotifyArtistId/],
    ['portada no https', { ...valid(), coverUrl: 'http://x.example/a.jpg' }, /^coverUrl/],
    ['campo desconocido', { ...valid(), mood: 'x' }, 'mood: unknown field'],
  ])('rechaza: %s', (_name, input, expected) => {
    const result = parseTrackInput(input, NOW);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(
      errors.some((error) =>
        typeof expected === 'string' ? error === expected : expected.test(error),
      ),
    ).toBe(true);
  });

  it('informa todos los errores juntos', () => {
    const result = parseTrackInput({ date: 'x' }, NOW);
    expect(result.ok ? [] : result.errors.length).toBeGreaterThan(5);
  });

  it.each([null, [], 'texto', 3])('rechaza una entrada que no es un objeto: %j', (input) => {
    expect(parseTrackInput(input, NOW)).toEqual({
      ok: false,
      errors: ['input must be a JSON object'],
    });
  });
});
