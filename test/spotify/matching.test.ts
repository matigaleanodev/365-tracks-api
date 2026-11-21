import { describe, expect, it } from 'vitest';
import { coreTitle, matchProposal, normalizeArtist } from '../../src/spotify/matching.ts';
import { spotifyId, spotifyTrack } from '../support/music.ts';

const options = { editorialDate: '2027-03-15', requireAnniversary: false } as const;
const proposal = { title: 'Blue Monday', artist: 'New Order', releaseYear: 1983 };

const candidate = (n: number, overrides = {}) =>
  spotifyTrack(spotifyId(n), {
    title: 'Blue Monday',
    artist: 'New Order',
    artistId: 'neworder0000000000000A',
    artists: [{ id: 'neworder0000000000000A', name: 'New Order' }],
    releaseYear: 1983,
    releaseDate: '1983-03-07',
    ...overrides,
  });

describe('coreTitle / normalizeArtist', () => {
  it.each([
    ['Blue Monday - 2015 Remaster', 'blue monday'],
    ['Blue Monday (Remastered 2011)', 'blue monday'],
    ['Blue Monday - Single Version', 'blue monday'],
    ['Blue Monday (Mono)', 'blue monday'],
    ['Blue Monday - 12" Version', 'blue monday 12 version'],
    ['Canción Ñandú', 'cancion nandu'],
  ])('%s → %s', (title, expected) => {
    expect(coreTitle(title)).toBe(expected);
  });

  it('ignora el artículo inicial del artista', () => {
    expect(normalizeArtist('The Beatles')).toBe(normalizeArtist('Beatles'));
  });
});

describe('matchProposal', () => {
  it('sin resultados se rechaza', () => {
    expect(matchProposal([], proposal, options)).toEqual({
      status: 'rejected',
      reason: 'no-results',
    });
  });

  it('acepta la coincidencia exacta y la devuelve', () => {
    const result = matchProposal([candidate(1)], proposal, options);
    expect(result).toMatchObject({ status: 'matched', track: { id: spotifyId(1) } });
  });

  it('ignora remasters y versiones de single del título', () => {
    const remaster = candidate(2, { title: 'Blue Monday - 2015 Remaster' });
    expect(matchProposal([remaster], proposal, options).status).toBe('matched');
  });

  it('rechaza otro artista aunque el título coincida (un cover)', () => {
    const cover = candidate(3, { artist: 'Orgy', artistId: 'orgy00000000000000000A' });
    expect(matchProposal([cover], proposal, options)).toMatchObject({
      reason: 'artist-mismatch',
    });
  });

  it('rechaza un título distinto', () => {
    expect(
      matchProposal([candidate(4, { title: 'Bizarre Love Triangle' })], proposal, options),
    ).toMatchObject({
      reason: 'title-mismatch',
    });
  });

  it('rechaza una versión extendida o alternativa como versión equivocada', () => {
    const extended = candidate(5, { title: 'Blue Monday - Extended Dance Mix' });
    expect(matchProposal([extended], proposal, options)).toMatchObject({
      reason: 'wrong-version',
    });
  });

  it('descarta álbumes en vivo salvo que se pidan', () => {
    const live = candidate(6, { album: 'Live at Wembley', releaseYear: 1983 });
    expect(matchProposal([live], proposal, options)).toMatchObject({ reason: 'wrong-version' });
    expect(
      matchProposal([live], { ...proposal, title: 'Blue Monday (Live)' }, options),
    ).toMatchObject({ reason: 'title-mismatch' });
  });

  it('es ambiguo si hay perfiles de artista distintos con el mismo nombre', () => {
    const other = candidate(7, { artistId: 'neworder0000000000000B' });
    expect(matchProposal([candidate(1), other], proposal, options)).toMatchObject({
      reason: 'ambiguous',
    });
  });

  it('tolera un año de diferencia pero no más', () => {
    expect(matchProposal([candidate(8, { releaseYear: 1984 })], proposal, options).status).toBe(
      'matched',
    );
    expect(matchProposal([candidate(9, { releaseYear: 1986 })], proposal, options)).toMatchObject({
      reason: 'year-mismatch',
    });
  });

  it('entre varios lanzamientos prefiere año exacto, no compilación y el más antiguo', () => {
    const compilation = candidate(10, {
      albumType: 'compilation',
      releaseDate: '1983-03-07',
    });
    const reissue = candidate(11, { releaseYear: 1984, releaseDate: '1984-01-01' });
    const original = candidate(12, { releaseDate: '1983-03-07' });
    const result = matchProposal([reissue, compilation, original], proposal, options);
    expect(result).toMatchObject({ status: 'matched', track: { id: spotifyId(12) } });
  });
});

describe('efemérides verificables', () => {
  const anniversary = { editorialDate: '2027-03-07', requireAnniversary: true } as const;
  const claimed = { ...proposal, releaseDate: '1983-03-07' };

  it('acepta cuando Spotify confirma el día exacto', () => {
    expect(matchProposal([candidate(1)], claimed, anniversary).status).toBe('matched');
  });

  it('rechaza si el modelo no informa fecha completa', () => {
    expect(matchProposal([candidate(1)], proposal, anniversary)).toMatchObject({
      reason: 'anniversary-unverified',
    });
  });

  it('rechaza si Spotify solo conoce el año o el mes', () => {
    const yearOnly = candidate(1, { releaseDate: '1983', releaseDatePrecision: 'year' });
    expect(matchProposal([yearOnly], claimed, anniversary)).toMatchObject({
      reason: 'anniversary-unverified',
    });
  });

  it('rechaza si el día afirmado no coincide con el de Spotify', () => {
    const wrongDay = candidate(1, { releaseDate: '1983-03-08' });
    expect(matchProposal([wrongDay], claimed, anniversary)).toMatchObject({
      reason: 'anniversary-unverified',
    });
  });

  it('rechaza si la fecha no es el mismo mes y día que la fecha editorial', () => {
    expect(
      matchProposal([candidate(1)], claimed, { ...anniversary, editorialDate: '2027-03-08' }),
    ).toMatchObject({ reason: 'anniversary-unverified' });
  });

  it('rechaza un lanzamiento del mismo año (no es un aniversario)', () => {
    const sameYear = candidate(1, { releaseYear: 2027, releaseDate: '2027-03-07' });
    expect(
      matchProposal(
        [sameYear],
        { ...proposal, releaseYear: 2027, releaseDate: '2027-03-07' },
        anniversary,
      ),
    ).toMatchObject({ reason: 'anniversary-unverified' });
  });
});
