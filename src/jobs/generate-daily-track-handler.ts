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
  stillMissing: string[];
}

/** Lo mínimo del contexto de Lambda que necesita el presupuesto de tiempo. */
export interface TimeContext {
  getRemainingTimeInMillis(): number;
}

/**
 * Margen para no empezar una fecha nueva cuando la Lambda está por vencer. Una fecha puede
 * tardar decenas de segundos (OpenAI + Spotify con reintentos). Si igual vence a mitad de una
 * fecha no se escribe nada de ella y la próxima ejecución la retoma.
 */
export const MIN_REMAINING_MS = 90_000;
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
    const report: ReplenishReport = await replenishCatalog(deps, undefined, {
      maxNew,
      hasTimeLeft: () => !context || context.getRemainingTimeInMillis() > MIN_REMAINING_MS,
    });
    const output: CatalogJobOutput = {
      from: report.from,
      to: report.to,
      preparedBefore: report.preparedBefore,
      created: report.created,
      incomplete: report.incomplete,
      deferred: report.deferred,
      stillMissing: report.stillMissing,
    };
    console.info(JSON.stringify({ event: 'catalog-replenish', ...output }));
    const failure = report.outcomes.find((outcome) => outcome.status === 'failed');
    if (failure?.status === 'failed') {
      throw new Error(`Catalog replenishment stopped at ${failure.date}: ${failure.error}`);
    }
    return output;
  };
}

export const handler = createReplenishCatalogHandler(() => createCatalogDependencies(process.env), {
  maxNew: Number(process.env.CATALOG_MAX_NEW_PER_RUN) || DEFAULT_MAX_NEW_PER_RUN,
});
