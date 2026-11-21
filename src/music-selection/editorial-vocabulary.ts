import type { EditorialCriterion } from './criteria.ts';

/**
 * Vocabulario editorial cerrado. El modelo solo elige identificadores; el texto público se
 * compone aquí, en español, con plantillas fijas. Ninguna frase contiene fechas, cifras,
 * épocas, hechos históricos, superlativos, rankings ni citas: por construcción, una descripción
 * generada no puede afirmar nada que no se pueda verificar.
 */

export const MIN_TRAITS = 2;
export const MAX_TRAITS = 3;

/** Rasgos del carácter musical (instrumentos, clima, voz, ritmo, producción, composición). */
export const TRAIT_PHRASES = {
  'guitars-clean': 'sus guitarras de trazo limpio',
  'guitars-driven': 'unas guitarras con mucha presencia',
  'piano-led': 'un piano que conduce la melodía',
  'strings-arrangement': 'los arreglos de cuerdas',
  'brass-accents': 'unos vientos metálicos bien marcados',
  'synths-enveloping': 'unos sintetizadores envolventes',
  'acoustic-base': 'una base acústica sencilla',
  'bass-groove': 'una línea de bajo con mucho groove',
  'percussion-lively': 'una percusión que invita a moverse',
  'electronic-textures': 'unas texturas electrónicas cuidadas',
  'mood-warm': 'un clima cálido y cercano',
  'mood-melancholic': 'un tono melancólico sin dramatismo',
  'mood-energetic': 'una energía contagiosa',
  'mood-calm': 'una calma que se agradece',
  'mood-nocturnal': 'una atmósfera nocturna',
  'mood-luminous': 'un carácter luminoso',
  'mood-nostalgic': 'un aire nostálgico',
  'voice-intimate': 'una voz íntima y cercana',
  'voice-powerful': 'una voz potente',
  'voice-harmonies': 'las armonías vocales',
  'voice-spoken': 'una interpretación casi hablada',
  'voice-expressive': 'una interpretación expresiva',
  'rhythm-steady': 'un pulso firme y constante',
  'rhythm-danceable': 'un ritmo bailable',
  'rhythm-slow': 'un tempo pausado',
  'rhythm-syncopated': 'unos ritmos sincopados',
  'rhythm-driving': 'un impulso rítmico sostenido',
  'production-homemade': 'una producción de aire casero',
  'production-polished': 'una producción pulida',
  'production-spacious': 'un sonido amplio y espacioso',
  'production-raw': 'un sonido directo y sin adornos',
  'production-layered': 'unas capas de sonido bien trabajadas',
  'songwriting-melody': 'una melodía fácil de recordar',
  'songwriting-structure': 'una estructura sencilla y efectiva',
  'songwriting-imagery': 'una escritura de imágenes sugerentes',
  'songwriting-dynamics': 'los cambios de intensidad',
} as const satisfies Record<string, string>;

export type TraitId = keyof typeof TRAIT_PHRASES;
export const TRAIT_IDS = Object.keys(TRAIT_PHRASES) as TraitId[];

/** Motivos editoriales por criterio: oraciones completas, con punto final. */
export const REASON_PHRASES: Record<EditorialCriterion, Readonly<Record<string, string>>> = {
  classic: {
    'classic-fresh': 'Un clásico de la música grabada que sigue sonando fresco.',
    'classic-reference': 'Una canción de referencia, conocida por mucha gente.',
    'classic-revisit': 'Un clásico que vale la pena volver a escuchar con atención.',
    'classic-recognizable': 'Un tema que muchos reconocen desde el comienzo.',
    'classic-craft': 'Un clásico que muestra el oficio de su artista sin recurrir a lo obvio.',
  },
  'hidden-gem': {
    'gem-attentive': 'Una joya discreta que merece una escucha atenta.',
    'gem-quality': 'Un tema poco conocido y de calidad notable.',
    'gem-overlooked': 'Una canción de disco que suele pasar desapercibida.',
    'gem-discovery': 'Un descubrimiento para quienes buscan algo fuera del circuito habitual.',
    'gem-small-audience':
      'Una canción de un artista de público reducido que sorprende al escucharla.',
  },
  'music-anniversary': {},
  'genre-exploration': {
    'genre-gateway': 'Una buena puerta de entrada a un género que no siempre se explora.',
    'genre-scene': 'Una canción representativa de una escena musical para descubrir.',
    'genre-leave-habit': 'Una invitación a salir de los géneros de siempre.',
    'genre-clear-example': 'Un ejemplo claro de un estilo que conviene conocer.',
    'genre-accessible': 'Una forma accesible de acercarse a un sonido distinto.',
  },
  'recent-release': {
    'recent-contemporary': 'Una canción de sonido contemporáneo que vale la pena conocer.',
    'recent-sound': 'Un tema que muestra cómo suena la música de estos días.',
    'recent-novelty': 'Una novedad con personalidad propia que merece una escucha.',
    'recent-fresh': 'Una canción de aire actual, pensada para escuchar con calma.',
  },
  'cultural-date': {
    'date-celebration': 'Una canción para acompañar una jornada de celebración compartida.',
    'date-gathering': 'Un tema pensado para una fecha de encuentro y descanso.',
    'date-festive': 'Una canción que va bien con el ánimo festivo de ciertos días.',
    'date-pause': 'Un tema para marcar una pausa en el calendario.',
  },
};

/** Identificadores de motivo válidos para un criterio (vacío si no se admite). */
export const reasonIdsFor = (criterion: EditorialCriterion): string[] =>
  Object.keys(REASON_PHRASES[criterion]);

export const isTraitId = (value: unknown): value is TraitId =>
  typeof value === 'string' && Object.hasOwn(TRAIT_PHRASES, value);

export const isReasonId = (criterion: EditorialCriterion, value: unknown): value is string =>
  typeof value === 'string' && Object.hasOwn(REASON_PHRASES[criterion], value);

/**
 * Compone la descripción pública: "<motivo> Se destaca por <rasgo>, <rasgo> y <rasgo>.".
 * Devuelve null si algún identificador no pertenece al vocabulario, si hay rasgos repetidos o
 * si la cantidad de rasgos no es la esperada: nunca se improvisa texto.
 */
export function composeDescription(
  criterion: EditorialCriterion,
  reasonId: unknown,
  traitIds: unknown,
): string | null {
  if (!isReasonId(criterion, reasonId)) return null;
  if (!Array.isArray(traitIds)) return null;
  if (traitIds.length < MIN_TRAITS || traitIds.length > MAX_TRAITS) return null;
  if (!traitIds.every(isTraitId) || new Set(traitIds).size !== traitIds.length) return null;

  const phrases = traitIds.map((id) => TRAIT_PHRASES[id]);
  const last = phrases.pop() as string;
  const list = phrases.length === 0 ? last : `${phrases.join(', ')} y ${last}`;
  return `${REASON_PHRASES[criterion][reasonId]} Se destaca por ${list}.`;
}
