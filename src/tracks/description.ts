export const DESCRIPTION_MIN_LENGTH = 40;
export const DESCRIPTION_MAX_LENGTH = 500;

const URL_PATTERN = /https?:\/\/|www\./i;
/** Comillas de cualquier estilo: delatan una cita o un fragmento de letra, que no se admiten. */
const QUOTE_PATTERN = /["“”„«»‟]/;
const YEAR_PATTERN = /\b(?:1[89]|20)\d{2}\b/g;
/**
 * Meses en español e inglés, salvo "may" y "march" que son palabras comunes. Es una heurística:
 * detecta la mayoría de las afirmaciones de fecha, no todas.
 */
const MONTH_PATTERN =
  /\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|april|june|july|august|september|october|november|december)\b/i;

export interface DescriptionRules {
  /**
   * Si se informa, cualquier año de cuatro cifras del texto debe estar en la lista. Evita que una
   * descripción generada afirme fechas que no se verificaron contra el catálogo.
   */
  allowedYears?: readonly number[];
  /** Rechaza nombres de mes: afirmaciones de fecha que el selector no verificó. */
  forbidMonths?: boolean;
}

/**
 * Problemas de una descripción editorial; vacío si es válida. Las reglas son estructurales:
 * el contenido factual se controla en origen (el selector solo afirma lo que verifica).
 */
export function findDescriptionIssues(value: unknown, rules: DescriptionRules = {}): string[] {
  if (typeof value !== 'string') return ['must be a string'];
  const text = value.trim();
  const issues: string[] = [];
  if (text.length < DESCRIPTION_MIN_LENGTH) {
    issues.push(`must be at least ${DESCRIPTION_MIN_LENGTH} characters`);
  }
  if (text.length > DESCRIPTION_MAX_LENGTH) {
    issues.push(`must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
  }
  if (/[\r\n]/.test(text)) issues.push('must be a single paragraph');
  if (URL_PATTERN.test(text)) issues.push('must not contain links');
  if (QUOTE_PATTERN.test(text)) issues.push('must not contain quotations');
  if (rules.forbidMonths && MONTH_PATTERN.test(text)) {
    issues.push('mentions a date that was not verified');
  }
  if (rules.allowedYears !== undefined) {
    const years = (text.match(YEAR_PATTERN) ?? []).map(Number);
    if (years.some((year) => !rules.allowedYears?.includes(year))) {
      issues.push('mentions a year that was not verified');
    }
  }
  return issues;
}
