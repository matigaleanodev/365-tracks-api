import { addDays, getEditorialDate, type IsoDate } from '../shared/dates.ts';
import { findIncompleteFields } from './completeness.ts';
import { generateDailyTrack, type GenerateDailyTrackDependencies } from './generate-daily-track.ts';
import { PUBLICATION_START_DATE } from './publication.ts';
import type { TrackRepository } from './repository.ts';

/** Fechas que el catálogo mantiene preparadas por adelantado. */
export const CATALOG_WINDOW_DAYS = 30;

/**
 * Ventana móvil de fechas que deben tener canción. Arranca en la fecha UTC de ayer porque la
 * zona más atrasada (UTC-12) todavía vive "ayer"; la más adelantada (UTC+14) ya vive "mañana".
 * Nunca empieza antes del lanzamiento. Con 30 días quedan ~27 de margen sobre la zona líder.
 */
export function getCatalogWindow(
  now: Date,
  windowDays = CATALOG_WINDOW_DAYS,
  start: IsoDate = PUBLICATION_START_DATE,
): IsoDate[] {
  const yesterday = addDays(getEditorialDate(now), -1);
  const first = yesterday > start ? yesterday : start;
  return Array.from({ length: windowDays }, (_, index) => addDays(first, index));
}

export interface CatalogStatus {
  from: IsoDate;
  to: IsoDate;
  /** Con todos los metadatos y una descripción válida: lista para publicar. */
  prepared: IsoDate[];
  /** Existen pero están incompletas (por ejemplo sin descripción). No se pisan ni se publican. */
  incomplete: IsoDate[];
  /** No tienen ninguna canción: es lo único que la reposición completa. */
  missing: IsoDate[];
}

/** Solo lee (GetItem por fecha): no necesita permisos de escritura ni de Query. */
export async function getCatalogStatus(
  repository: Pick<TrackRepository, 'getByDate'>,
  window: readonly IsoDate[],
): Promise<CatalogStatus> {
  const found = await Promise.all(window.map((date) => repository.getByDate(date)));
  const prepared: IsoDate[] = [];
  const incomplete: IsoDate[] = [];
  const missing: IsoDate[] = [];
  window.forEach((date, index) => {
    const track = found[index];
    if (!track) {
      missing.push(date);
    } else if (findIncompleteFields(track).length > 0) {
      incomplete.push(date);
    } else {
      prepared.push(date);
    }
  });
  return { from: window[0] ?? '', to: window.at(-1) ?? '', prepared, incomplete, missing };
}

export type ReplenishOutcome =
  | { date: IsoDate; status: 'created' | 'already-exists' }
  | { date: IsoDate; status: 'failed'; error: string }
  /** No se intentó porque una fecha anterior falló. */
  | { date: IsoDate; status: 'skipped' }
  /** No se intentó porque se agotó el presupuesto de esta ejecución; sigue en la próxima. */
  | { date: IsoDate; status: 'deferred' };

export interface ReplenishBudget {
  /** Máximo de fechas nuevas a preparar en esta ejecución (costo de OpenAI y Spotify). */
  maxNew?: number;
  /** Se consulta antes de cada fecha; false corta la ejecución antes de que venza la Lambda. */
  hasTimeLeft?: () => boolean;
}

export interface ReplenishReport {
  from: IsoDate;
  to: IsoDate;
  /** Estado previo a la reposición. */
  preparedBefore: number;
  created: IsoDate[];
  /** Existen pero incompletas: requieren corrección manual, la reposición no las toca. */
  incomplete: IsoDate[];
  /** Pendientes por presupuesto: avance normal, no es un error. */
  deferred: IsoDate[];
  /** Fechas que siguen sin canción al terminar (fallidas, omitidas o diferidas). */
  stillMissing: IsoDate[];
  outcomes: ReplenishOutcome[];
}

/**
 * Completa solo las fechas sin canción reutilizando `generateDailyTrack`, que es condicional e
 * idempotente: reintentar o ejecutar dos veces a la vez nunca pisa una fecha preparada.
 *
 * Es acotada y reanudable: procesa en orden (las fechas más próximas primero), respeta el
 * presupuesto y se detiene en el primer fallo (límites de Spotify, selección caída). Lo que no
 * se hizo se retoma en la próxima ejecución, porque el estado es el propio catálogo.
 */
export async function replenishCatalog(
  dependencies: GenerateDailyTrackDependencies,
  window: readonly IsoDate[] = getCatalogWindow(dependencies.now()),
  { maxNew = Number.POSITIVE_INFINITY, hasTimeLeft = () => true }: ReplenishBudget = {},
): Promise<ReplenishReport> {
  const status = await getCatalogStatus(dependencies.repository, window);
  const outcomes: ReplenishOutcome[] = [];
  let halted = false;
  let attempted = 0;

  for (const date of status.missing) {
    if (halted) {
      outcomes.push({ date, status: 'skipped' });
      continue;
    }
    if (attempted >= maxNew || !hasTimeLeft()) {
      outcomes.push({ date, status: 'deferred' });
      continue;
    }
    attempted += 1;
    try {
      const { status: result } = await generateDailyTrack(dependencies, date);
      outcomes.push({ date, status: result });
    } catch (error) {
      halted = true;
      outcomes.push({
        date,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const datesWith = (...statuses: ReplenishOutcome['status'][]) =>
    outcomes.filter((o) => statuses.includes(o.status)).map((o) => o.date);

  return {
    from: status.from,
    to: status.to,
    preparedBefore: status.prepared.length,
    created: datesWith('created'),
    incomplete: status.incomplete,
    deferred: datesWith('deferred'),
    stillMissing: datesWith('failed', 'skipped', 'deferred'),
    outcomes,
  };
}
