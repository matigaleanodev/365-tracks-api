export const EDITORIAL_CRITERIA = [
  'classic',
  'hidden-gem',
  'music-anniversary',
  'genre-exploration',
  'recent-release',
  'cultural-date',
] as const;

export type EditorialCriterion = (typeof EDITORIAL_CRITERIA)[number];
export type CriteriaWeights = Record<EditorialCriterion, number>;

/**
 * Criterios que no se pueden usar automáticamente. `music-anniversary` queda deshabilitado: la
 * fecha de un álbum en Spotify no prueba la fecha original de la canción y no hay una fuente
 * independiente integrada para verificarla. Se conserva el nombre en el tipo porque puede
 * existir en registros ya guardados. Para rehabilitarlo hace falta una fuente verificable.
 */
export const DISABLED_CRITERIA: readonly EditorialCriterion[] = ['music-anniversary'];

/** Distribución editorial inicial. Son objetivos de diversidad del catálogo, no probabilidades. */
export const DEFAULT_CRITERIA_WEIGHTS: CriteriaWeights = {
  classic: 0.25,
  'hidden-gem': 0.3125,
  'music-anniversary': 0,
  'genre-exploration': 0.1875,
  'recent-release': 0.125,
  'cultural-date': 0.125,
};

/** Instrucción editorial de cada criterio. Es lo único del criterio que recibe el modelo. */
export const CRITERION_BRIEF: Record<EditorialCriterion, string> = {
  classic:
    'A widely recognised classic of recorded music that has stood the test of time. Fame is welcome, but avoid the single most obvious hit of the artist when a strong alternative exists.',
  'hidden-gem':
    'A lesser-known song of real quality: an album track, a B-side or a song by an artist with a small audience. Do not choose the best-known hit of the artist.',
  'music-anniversary':
    'Disabled: the original release date cannot be verified independently, so this criterion is never requested.',
  'genre-exploration':
    'A representative song from a genre or scene that listeners may not explore by default. It must be a good entry point to that style, not a niche curiosity.',
  'recent-release':
    'One of the most recent releases you know of, from the last two years before the date. Propose only songs you are sure exist.',
  'cultural-date':
    'A song connected to a widely known cultural occasion of this calendar date (a holiday, a season, a solstice or equinox, a broadly celebrated day). Name the occasion only if it is universally known; do not assert historical events.',
};

/**
 * Valida y normaliza pesos configurados (JSON con los seis criterios). Los pesos solo importan
 * en relación con los demás: se normalizan para que sumen 1. Un peso 0 excluye el criterio.
 */
export function parseCriteriaWeights(raw: string | undefined): CriteriaWeights {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CRITERIA_WEIGHTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Criteria weights must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Criteria weights must be a JSON object');
  }
  const input = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter(
    (key) => !(EDITORIAL_CRITERIA as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Criteria weights has unknown criteria: ${unknownKeys.join(', ')}`);
  }
  const weights = {} as CriteriaWeights;
  let total = 0;
  for (const criterion of EDITORIAL_CRITERIA) {
    const value = input[criterion];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Criteria weight "${criterion}" must be a non-negative number`);
    }
    if (value > 0 && DISABLED_CRITERIA.includes(criterion)) {
      throw new Error(`Criteria weight "${criterion}" must be 0: the criterion is disabled`);
    }
    weights[criterion] = value;
    total += value;
  }
  if (!Number.isFinite(total)) {
    throw new Error('Criteria weights are too large');
  }
  if (total <= 0) {
    throw new Error('Criteria weights must have at least one positive weight');
  }
  for (const criterion of EDITORIAL_CRITERIA) {
    weights[criterion] /= total;
  }
  return weights;
}

/**
 * Criterios ordenados por cuánto les falta para alcanzar su peso en el catálogo ya preparado
 * (fechas pasadas y futuras). Es determinista y converge a la distribución objetivo; lo que no
 * es un criterio automático (por ejemplo `manual`) no cuenta ni desplaza a ninguno.
 */
export function rankCriteria(
  history: readonly { selectionCriterion: string }[],
  weights: CriteriaWeights = DEFAULT_CRITERIA_WEIGHTS,
): EditorialCriterion[] {
  const counts = new Map<string, number>();
  for (const { selectionCriterion } of history) {
    counts.set(selectionCriterion, (counts.get(selectionCriterion) ?? 0) + 1);
  }
  const total = EDITORIAL_CRITERIA.reduce((sum, c) => sum + (counts.get(c) ?? 0), 0);
  const deficit = (criterion: EditorialCriterion) =>
    weights[criterion] * (total + 1) - (counts.get(criterion) ?? 0);

  return EDITORIAL_CRITERIA.filter(
    (criterion) => weights[criterion] > 0 && !DISABLED_CRITERIA.includes(criterion),
  ).sort(
    (a, b) =>
      deficit(b) - deficit(a) ||
      weights[b] - weights[a] ||
      EDITORIAL_CRITERIA.indexOf(a) - EDITORIAL_CRITERIA.indexOf(b),
  );
}
