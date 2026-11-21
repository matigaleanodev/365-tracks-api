import { createTimeBudget, SELECTION_SAFETY_MARGIN_MS } from '../shared/time-budget.ts';
import { replenishCatalog, type ReplenishReport } from '../tracks/catalog.ts';
import type { GenerateDailyTrackDependencies } from '../tracks/generate-daily-track.ts';
import { createCatalogDependencies } from './dependencies.ts';

export interface CatalogJobOutput {
  from: string;
  to: string;
  preparedBefore: number;
  created: string[];
  /** Existen pero incompletas: requieren corrección manual. */
  incomplete: string[];
  /** Pendientes por presupuesto de esta ejecución: se retoman en la siguiente. */
  deferred: string[];
  /** El tiempo de la invocación se agotó a mitad de una fecha (avance normal, no error). */
  budgetExhausted: boolean;
  stillMissing: string[];
}

/**
 * La invocación agotó su presupuesto sin completar ninguna fecha. No se escribió nada y la
 * próxima ejecución reintenta (es idempotente), pero sin avance debe contar como fallo. El
 * mensaje lleva solo fechas y conteos.
 */
export class CatalogNoProgressError extends Error {
  constructor(deferred: readonly string[]) {
    super(
      `Catalog replenishment made no progress: time budget exhausted with ${deferred.length} date(s) deferred${deferred[0] ? ` starting at ${deferred[0]}` : ''}`,
    );
    this.name = 'CatalogNoProgressError';
  }
}

/** Lo mínimo del contexto de Lambda que necesita el presupuesto de tiempo. */
export interface TimeContext {
  getRemainingTimeInMillis(): number;
}

/**
 * No se empieza una fecha nueva con menos tiempo que el peor caso de UN intento de cada paso:
 * token de Spotify (10 s) + OpenAI (45 s) + dos búsquedas (20 s) + getTrack (10 s) + la reserva
 * de persistencia. Es una heurística para no arrancar lo que casi seguro no termina; la garantía
 * real la da el presupuesto de tiempo, que corta cualquier llamada que no entre y no escribe
 * nada de la fecha interrumpida (la próxima ejecución la retoma).
 */
export const MIN_REMAINING_MS = 10_000 + 45_000 + 20_000 + 10_000 + SELECTION_SAFETY_MARGIN_MS;
export const DEFAULT_MAX_NEW_PER_RUN = 5;

type DependenciesSource =
  GenerateDailyTrackDependencies | (() => Promise<GenerateDailyTrackDependencies>);

export interface ReplenishHandlerOptions {
  /** Tope de fechas nuevas por ejecución: acota el costo de OpenAI y Spotify. */
  maxNew?: number;
}

/**
 * Proceso de reposición del catálogo: completa solo las fechas sin canción de la ventana móvil,
 * de forma acotada y reanudable. No genera "la canción de hoy": cada fecha se prepara con
 * anticipación. Si una fecha falla, informa el avance y termina con error (alarma/reintento del
 * Scheduler). El log lleva fechas y conteos, nunca títulos ni artistas de canciones futuras.
 */
export function createReplenishCatalogHandler(
  source: DependenciesSource,
  { maxNew = DEFAULT_MAX_NEW_PER_RUN }: ReplenishHandlerOptions = {},
) {
  let resolved: Promise<GenerateDailyTrackDependencies> | undefined;
  const dependencies = () =>
    typeof source === 'function' ? (resolved ??= source()) : Promise.resolve(source);

  return async (_event?: unknown, context?: TimeContext): Promise<CatalogJobOutput> => {
    const deps = await dependencies();
    // Un presupuesto por invocación: los clientes viven entre invocaciones, el tiempo no.
    const budget =
      context &&
      createTimeBudget({
        deadlineMs: Date.now() + context.getRemainingTimeInMillis(),
        reserveMs: SELECTION_SAFETY_MARGIN_MS,
      });
    const report: ReplenishReport = await replenishCatalog(deps, undefined, {
      maxNew,
      hasTimeLeft: () => !context || context.getRemainingTimeInMillis() > MIN_REMAINING_MS,
      ...(budget && { budget }),
    });
    const output: CatalogJobOutput = {
      from: report.from,
      to: report.to,
      preparedBefore: report.preparedBefore,
      created: report.created,
      incomplete: report.incomplete,
      deferred: report.deferred,
      budgetExhausted: report.budgetExhausted,
      stillMissing: report.stillMissing,
    };
    console.info(JSON.stringify({ event: 'catalog-replenish', ...output }));
    const failure = report.outcomes.find((outcome) => outcome.status === 'failed');
    if (failure?.status === 'failed') {
      throw new Error(`Catalog replenishment stopped at ${failure.date}: ${failure.error}`);
    }
    if (report.budgetExhausted && report.created.length === 0) {
      console.error(
        JSON.stringify({
          event: 'catalog-replenish-no-progress',
          from: output.from,
          to: output.to,
          deferred: output.deferred.length,
          firstDeferred: output.deferred[0],
        }),
      );
      throw new CatalogNoProgressError(output.deferred);
    }
    return output;
  };
}

export const handler = createReplenishCatalogHandler(() => createCatalogDependencies(process.env), {
  maxNew: Number(process.env.CATALOG_MAX_NEW_PER_RUN) || DEFAULT_MAX_NEW_PER_RUN,
});
