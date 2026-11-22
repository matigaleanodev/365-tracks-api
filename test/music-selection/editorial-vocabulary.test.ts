import { describe, expect, it } from 'vitest';
import { DISABLED_CRITERIA, EDITORIAL_CRITERIA } from '../../src/music-selection/criteria.ts';
import {
  composeDescription,
  MAX_TRAITS,
  MIN_TRAITS,
  REASON_PHRASES,
  reasonIdsFor,
  TRAIT_IDS,
  TRAIT_PHRASES,
} from '../../src/music-selection/editorial-vocabulary.ts';
import { findDescriptionIssues } from '../../src/tracks/description.ts';

const allPhrases = [
  ...Object.values(TRAIT_PHRASES),
  ...Object.values(REASON_PHRASES).flatMap((reasons) => Object.values(reasons)),
];

/** Lista de verificación de la prueba (no de producción): palabras que no pueden aparecer. */
const FORBIDDEN_WORDS = [
  // meses
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre',
  'january|february|march|april|may|june|july|august|september|october|november|december',
  // números y ordinales en español
  'cero|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte',
  'treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mil|millón|millones',
  'primero|primer|primera|segundo|segunda|tercer|tercero|tercera|cuarto|quinto|décimo',
  // números en inglés
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|first|second',
  // épocas, historia y rankings
  'década|décadas|siglo|siglos|año|años|época|histórico|histórica|historia|guerra|premio|récord|ranking|listas?',
  'setentas|ochentas|noventas|sesentas',
  // superlativos
  'más|mejor|mejores|mayor|peor|único|única|último|última|ícono|icónica|icónico|legendaria|legendario',
].join('|');
const FORBIDDEN = new RegExp(`(?<![\\p{L}])(?:${FORBIDDEN_WORDS})(?![\\p{L}])`, 'iu');

describe('vocabulario editorial', () => {
  it('es suficientemente variado', () => {
    expect(TRAIT_IDS.length).toBeGreaterThanOrEqual(25);
    for (const criterion of EDITORIAL_CRITERIA) {
      if (DISABLED_CRITERIA.includes(criterion)) continue;
      expect(reasonIdsFor(criterion).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('music-anniversary sigue deshabilitado y sin motivos', () => {
    expect(DISABLED_CRITERIA).toContain('music-anniversary');
    expect(reasonIdsFor('music-anniversary')).toEqual([]);
    expect(composeDescription('music-anniversary', 'x', ['mood-calm', 'mood-warm'])).toBeNull();
  });

  it('ninguna frase tiene dígitos, comillas, enlaces, meses, números ni superlativos', () => {
    expect(allPhrases.length).toBeGreaterThan(40);
    for (const phrase of allPhrases) {
      expect(phrase, phrase).not.toMatch(/\d|["“”«»'’]|https?:|www\./);
      expect(phrase, phrase).not.toMatch(FORBIDDEN);
      expect(phrase, phrase).not.toMatch(/\p{L}+(?:ísim[oa]s?)\b/u);
    }
  });

  it('los identificadores son únicos entre frases de un mismo grupo', () => {
    expect(new Set(Object.values(TRAIT_PHRASES)).size).toBe(TRAIT_IDS.length);
    for (const criterion of EDITORIAL_CRITERIA) {
      const phrases = Object.values(REASON_PHRASES[criterion]);
      expect(new Set(phrases).size).toBe(phrases.length);
    }
  });

  it('compone el texto con la plantilla fija', () => {
    expect(composeDescription('classic', 'classic-craft', ['mood-calm', 'rhythm-slow'])).toBe(
      'Un clásico que muestra el oficio de su artista sin recurrir a lo obvio. Se destaca por una calma que se agradece y un tempo pausado.',
    );
    expect(
      composeDescription('classic', 'classic-craft', ['mood-calm', 'rhythm-slow', 'mood-warm']),
    ).toMatch(
      /Se destaca por una calma que se agradece, un tempo pausado y un clima cálido y cercano\.$/,
    );
  });

  it('toda combinación reason + par/terna de rasgos pasa findDescriptionIssues', () => {
    let combinations = 0;
    const check = (
      criterion: (typeof EDITORIAL_CRITERIA)[number],
      reason: string,
      traits: string[],
    ) => {
      const text = composeDescription(criterion, reason, traits);
      expect(text).not.toBeNull();
      expect(
        findDescriptionIssues(text, { forbidDigits: true, forbidMonths: true }),
        text ?? '',
      ).toEqual([]);
      combinations += 1;
    };
    for (const criterion of EDITORIAL_CRITERIA) {
      for (const reason of reasonIdsFor(criterion)) {
        for (let i = 0; i < TRAIT_IDS.length; i += 1) {
          for (let j = i + 1; j < TRAIT_IDS.length; j += 1) {
            check(criterion, reason, [TRAIT_IDS[i] as string, TRAIT_IDS[j] as string]);
            // Ternas: solo una muestra por par para acotar el costo, el largo ya está cubierto.
            const k = (j + 1) % TRAIT_IDS.length;
            if (k !== i && k !== j) {
              check(criterion, reason, [
                TRAIT_IDS[i] as string,
                TRAIT_IDS[j] as string,
                TRAIT_IDS[k] as string,
              ]);
            }
          }
        }
      }
    }
    expect(combinations).toBeGreaterThan(1000);
  });

  it('el peor caso (frases más largas) cabe en el límite de longitud', () => {
    const longest = [...TRAIT_IDS].sort(
      (a, b) => TRAIT_PHRASES[b].length - TRAIT_PHRASES[a].length,
    );
    for (const criterion of EDITORIAL_CRITERIA) {
      for (const reason of reasonIdsFor(criterion)) {
        const text = composeDescription(criterion, reason, longest.slice(0, MAX_TRAITS));
        expect(text?.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it('rechaza ids desconocidos, repetidos y cantidades incorrectas', () => {
    const ok = ['mood-calm', 'mood-warm'];
    expect(composeDescription('classic', 'classic-craft', ok)).not.toBeNull();
    expect(composeDescription('classic', 'gem-quality', ok)).toBeNull();
    expect(composeDescription('classic', 'toString', ok)).toBeNull();
    expect(composeDescription('classic', 'classic-craft', ['mood-calm', 'x'])).toBeNull();
    expect(composeDescription('classic', 'classic-craft', ['mood-calm', 'mood-calm'])).toBeNull();
    expect(composeDescription('classic', 'classic-craft', ['mood-calm'])).toBeNull();
    expect(MIN_TRAITS).toBe(2);
    expect(
      composeDescription('classic', 'classic-craft', TRAIT_IDS.slice(0, MAX_TRAITS + 1)),
    ).toBeNull();
    expect(composeDescription('classic', 'classic-craft', 'mood-calm')).toBeNull();
  });
});
