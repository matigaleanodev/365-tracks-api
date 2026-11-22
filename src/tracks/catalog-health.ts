import { addDays, type IsoDate } from '../shared/dates.ts';
import type { ReplenishReport } from './catalog.ts';

/**
 * Días consecutivos preparados desde el inicio de la ventana por debajo de los cuales el catálogo
 * se considera con poco margen. La ventana arranca en la fecha UTC de ayer y la zona más
 * adelantada (UTC+14) ya vive "mañana": con 7 días quedan unos 5 de margen sobre la fecha UTC de
 * hoy. Es tiempo suficiente para intervenir antes de que un visitante quede sin canción.
 */
export const RUNWAY_LOW_DAYS = 7;

/**
 * Clasificación de una ejecución de reposición, pensada para alarmas futuras:
 * - `catalog-complete`: no faltaba ninguna fecha (puede haber incompletas, ver `incompleteCount`).
 * - `progressed`: creó al menos una fecha y no falló.
 * - `stalled-no-time`: no creó nada porque quedó poco tiempo en la invocación. Es intencional y
 *   termina sin error; solo es preocupante si se repite.
 * - `stalled-budget-exhausted`: el tiempo se agotó a mitad de una fecha sin completar ninguna.
 * - `failed`: una fecha falló (tiene precedencia aunque antes se hayan creado otras).
 */
export type CatalogHealthStatus =
  'catalog-complete' | 'progressed' | 'stalled-no-time' | 'stalled-budget-exhausted' | 'failed';

export interface CatalogHealth {
  status: CatalogHealthStatus;
  /** Fechas existentes pero incompletas: requieren corrección manual. */
  incompleteCount: number;
  /** Fechas que seguían sin canción al terminar la ejecución. */
  missingCount: number;
  /** Días consecutivos preparados y completos desde el inicio de la ventana, al terminar. */
  preparedAhead: number;
  /** `preparedAhead` por debajo de `RUNWAY_LOW_DAYS`. */
  runwayLow: boolean;
}

export type CatalogHealthInput = Pick<
  ReplenishReport,
  | 'from'
  | 'to'
  | 'created'
  | 'incomplete'
  | 'deferred'
  | 'budgetExhausted'
  | 'stillMissing'
  | 'outcomes'
>;

/** Solo usa fechas y conteos del reporte; no depende de títulos ni artistas. */
export function classifyCatalogHealth(report: CatalogHealthInput): CatalogHealth {
  const failed = report.outcomes.some((outcome) => outcome.status === 'failed');
  const unready = new Set<IsoDate>([...report.incomplete, ...report.stillMissing]);

  let preparedAhead = 0;
  for (let date = report.from; report.from !== '' && date <= report.to; date = addDays(date, 1)) {
    if (unready.has(date)) {
      break;
    }
    preparedAhead += 1;
  }

  let status: CatalogHealthStatus;
  if (failed) {
    status = 'failed';
  } else if (report.budgetExhausted && report.created.length === 0) {
    status = 'stalled-budget-exhausted';
  } else if (report.created.length > 0) {
    status = 'progressed';
  } else if (report.deferred.length > 0) {
    status = 'stalled-no-time';
  } else {
    status = 'catalog-complete';
  }

  return {
    status,
    incompleteCount: report.incomplete.length,
    missingCount: report.stillMissing.length,
    preparedAhead,
    runwayLow: preparedAhead < RUNWAY_LOW_DAYS,
  };
}
