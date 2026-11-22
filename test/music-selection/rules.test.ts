import { describe, expect, it } from 'vitest';
import { getDiversityTargets } from '../../src/music-selection/diversity.ts';
import {
  CRITERION_BRIEF,
  DEFAULT_CRITERIA_WEIGHTS,
  EDITORIAL_CRITERIA,
  parseCriteriaWeights,
  rankCriteria,
} from '../../src/music-selection/criteria.ts';
import { buildHistory, findViolation } from '../../src/music-selection/rules.ts';
import { preparedTrack, spotifyId, spotifyTrack } from '../support/music.ts';

const ARTIST_ID = 'artist00000000000000AA';

const stored = (date: string, n: number, overrides = {}) =>
  preparedTrack(date, n, { artist: 'Radiohead', spotifyArtistId: ARTIST_ID, ...overrides });

const candidate = (n: number, overrides = {}) =>
  spotifyTrack(spotifyId(n), {
    title: `Other ${n}`,
    artist: 'Radiohead',
    artistId: ARTIST_ID,
    ...overrides,
  });

describe('findViolation', () => {
  const history = buildHistory([stored('2027-03-01', 1, { title: 'Creep' })]);

  it('rechaza una canción ya elegida por ID de Spotify', () => {
    expect(findViolation(candidate(1), '2027-08-01', history)).toBe('duplicate-track');
  });

  it('rechaza la misma grabación con otro ID de Spotify (título + artista)', () => {
    const rerelease = candidate(99, { title: 'Creep - Remastered 2009' });
    expect(findViolation(rerelease, '2027-08-01', history)).toBe('duplicate-recording');
  });

  it('rechaza el mismo artista a menos de 60 días, hacia adelante y hacia atrás', () => {
    expect(findViolation(candidate(2), '2027-03-30', history)).toBe('artist-cooldown');
    expect(findViolation(candidate(2), '2027-01-20', history)).toBe('artist-cooldown');
  });

  it('permite exactamente a los 60 días y bloquea a los 59', () => {
    // 2027-03-01 + 60 días = 2027-04-30: el límite es estricto (< 60).
    expect(findViolation(candidate(2), '2027-04-30', history)).toBeNull();
    expect(findViolation(candidate(2), '2027-04-29', history)).toBe('artist-cooldown');
  });

  it('detecta el mismo artista por nombre aunque el ID difiera o falte', () => {
    const noId = buildHistory([preparedTrack('2027-03-01', 5, { artist: 'The Radiohead' })]);
    const byName = candidate(6, { artistId: 'other0000000000000000B', artist: 'Radiohead' });
    expect(findViolation(byName, '2027-03-10', noId)).toBe('artist-cooldown');
  });

  it('detecta el mismo artista por ID aunque el nombre cambie', () => {
    const byId = candidate(7, { artist: 'Thom Yorke' });
    expect(findViolation(byId, '2027-03-10', history)).toBe('artist-cooldown');
  });

  it('acepta un artista distinto', () => {
    const other = candidate(8, { artist: 'Björk', artistId: 'bjork000000000000000AA' });
    expect(findViolation(other, '2027-03-02', history)).toBeNull();
  });
});

describe('criterios editoriales', () => {
  it('los pesos por defecto suman 1 y cubren los seis criterios', () => {
    const total = Object.values(DEFAULT_CRITERIA_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(Object.keys(DEFAULT_CRITERIA_WEIGHTS).sort()).toEqual([...EDITORIAL_CRITERIA].sort());
    expect(Object.keys(CRITERION_BRIEF).sort()).toEqual([...EDITORIAL_CRITERIA].sort());
  });

  it('rankCriteria converge a la distribución objetivo en 365 días', () => {
    const history: { selectionCriterion: string }[] = [];
    for (let day = 0; day < 365; day += 1) {
      const [next] = rankCriteria(history);
      history.push({ selectionCriterion: next as string });
    }
    for (const criterion of EDITORIAL_CRITERIA) {
      const share = history.filter((h) => h.selectionCriterion === criterion).length / 365;
      expect(Math.abs(share - DEFAULT_CRITERIA_WEIGHTS[criterion])).toBeLessThan(0.02);
    }
  });

  it('las canciones manuales no desplazan a ningún criterio', () => {
    const manual = Array.from({ length: 50 }, () => ({ selectionCriterion: 'manual' }));
    expect(rankCriteria(manual)).toEqual(rankCriteria([]));
  });

  it('un peso 0 excluye el criterio', () => {
    const weights = parseCriteriaWeights(
      JSON.stringify({ ...DEFAULT_CRITERIA_WEIGHTS, 'recent-release': 0 }),
    );
    expect(rankCriteria([], weights)).not.toContain('recent-release');
  });

  it('music-anniversary está deshabilitado y el resto se redistribuye', () => {
    expect(DEFAULT_CRITERIA_WEIGHTS['music-anniversary']).toBe(0);
    const history: { selectionCriterion: string }[] = [];
    for (let day = 0; day < 365; day += 1) {
      const [next] = rankCriteria(history);
      history.push({ selectionCriterion: next as string });
    }
    expect(history.some((h) => h.selectionCriterion === 'music-anniversary')).toBe(false);
    expect(() =>
      parseCriteriaWeights(JSON.stringify({ ...DEFAULT_CRITERIA_WEIGHTS, 'music-anniversary': 1 })),
    ).toThrow(/disabled/);
  });

  it('rechaza pesos cuya suma desborda', () => {
    const huge = { ...DEFAULT_CRITERIA_WEIGHTS, classic: 1e308, 'hidden-gem': 1e308 };
    expect(() => parseCriteriaWeights(JSON.stringify(huge))).toThrow(/too large/);
  });

  it('parseCriteriaWeights normaliza y valida', () => {
    const doubled = Object.fromEntries(
      Object.entries(DEFAULT_CRITERIA_WEIGHTS).map(([k, v]) => [k, v * 10]),
    );
    const parsed = parseCriteriaWeights(JSON.stringify(doubled));
    expect(parsed.classic).toBeCloseTo(0.25);
    expect(parseCriteriaWeights(undefined)).toEqual(DEFAULT_CRITERIA_WEIGHTS);
    expect(() => parseCriteriaWeights('no json')).toThrow(/JSON object/);
    expect(() => parseCriteriaWeights('[]')).toThrow(/JSON object/);
    expect(() => parseCriteriaWeights(JSON.stringify({ ...doubled, extra: 1 }))).toThrow(/unknown/);
    expect(() => parseCriteriaWeights(JSON.stringify({ ...doubled, classic: -1 }))).toThrow(
      /non-negative/,
    );
    expect(() => parseCriteriaWeights(JSON.stringify({ classic: 1 }))).toThrow(/non-negative/);
    const zeros = Object.fromEntries(EDITORIAL_CRITERIA.map((c) => [c, 0]));
    expect(() => parseCriteriaWeights(JSON.stringify(zeros))).toThrow(/positive/);
  });
});

describe('getDiversityTargets', () => {
  it('es determinista para una fecha', () => {
    expect(getDiversityTargets('2027-05-05')).toEqual(getDiversityTargets('2027-05-05'));
  });

  it('alterna década, región y género entre días consecutivos', () => {
    const days = Array.from({ length: 14 }, (_, i) =>
      getDiversityTargets(`2027-05-${String(i + 1).padStart(2, '0')}`),
    );
    for (const key of ['decade', 'region', 'genre'] as const) {
      for (let i = 1; i < days.length; i += 1) {
        expect(days[i]?.[key]).not.toBe(days[i - 1]?.[key]);
      }
      expect(new Set(days.map((d) => d[key])).size).toBeGreaterThanOrEqual(6);
    }
  });
});
