import { AmbiguousSpotifyWriteError } from '../spotify/playlist-client.ts';
import { syncPlaylists, type SyncDependencies } from '../playlist/sync.ts';
import { createPlaylistDependencies } from './dependencies.ts';

export interface PlaylistJobOutput {
  lastEligible: string;
  years: { year: number; added: number; adopted: number }[];
  skippedIncomplete: string[];
  skippedLocked: number[];
}

/**
 * Sincronización de la playlist histórica. Es independiente de la preparación del catálogo: solo
 * agrega canciones de días ya terminados en todas las zonas (desde las 12:00 UTC de D+1) y es
 * idempotente. El log lleva conteos, nunca títulos.
 */
export interface PlaylistInvocationContext {
  getRemainingTimeInMillis(): number;
}

export function createSyncPlaylistHandler(
  source: SyncDependencies | (() => Promise<SyncDependencies>),
) {
  let resolved: Promise<SyncDependencies> | undefined;
  const dependencies = () =>
    typeof source === 'function' ? (resolved ??= source()) : Promise.resolve(source);

  return async (
    _event?: unknown,
    context?: PlaylistInvocationContext,
  ): Promise<PlaylistJobOutput> => {
    const deps = await dependencies();
    // Con contexto de Lambda, el presupuesto de escritura también respeta el tiempo restante.
    const deadlineMs = context
      ? deps.now().getTime() + context.getRemainingTimeInMillis()
      : undefined;
    let report;
    try {
      report = await syncPlaylists(deps, deadlineMs === undefined ? {} : { deadlineMs });
    } catch (error) {
      if (error instanceof AmbiguousSpotifyWriteError) {
        // Sin títulos ni cuerpos: el candado queda vigente hasta que venza.
        console.error(
          JSON.stringify({ event: 'playlist-sync-ambiguous-write', message: error.message }),
        );
      }
      throw error;
    }
    const output: PlaylistJobOutput = {
      lastEligible: report.lastEligible,
      years: report.years.map(({ year, added, adopted }) => ({
        year,
        added: added.length,
        adopted: adopted.length,
      })),
      skippedIncomplete: report.skippedIncomplete,
      skippedLocked: report.skippedLocked,
    };
    console.info(JSON.stringify({ event: 'playlist-sync', ...output }));
    return output;
  };
}

export const handler = createSyncPlaylistHandler(() => createPlaylistDependencies(process.env));
