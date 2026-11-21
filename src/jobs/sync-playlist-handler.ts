import { syncPlaylists, type SyncDependencies } from '../playlist/sync.ts';
import { createPlaylistDependencies } from './dependencies.ts';

export interface PlaylistJobOutput {
  lastEligible: string;
  years: { year: number; added: number; adopted: number }[];
  skippedIncomplete: string[];
}

/**
 * Sincronización de la playlist histórica. Es independiente de la preparación del catálogo: solo
 * agrega canciones de días ya terminados en todas las zonas (desde las 12:00 UTC de D+1) y es
 * idempotente. El log lleva conteos, nunca títulos.
 */
export function createSyncPlaylistHandler(
  source: SyncDependencies | (() => Promise<SyncDependencies>),
) {
  let resolved: Promise<SyncDependencies> | undefined;
  const dependencies = () =>
    typeof source === 'function' ? (resolved ??= source()) : Promise.resolve(source);

  return async (): Promise<PlaylistJobOutput> => {
    const report = await syncPlaylists(await dependencies());
    const output: PlaylistJobOutput = {
      lastEligible: report.lastEligible,
      years: report.years.map(({ year, added, adopted }) => ({
        year,
        added: added.length,
        adopted: adopted.length,
      })),
      skippedIncomplete: report.skippedIncomplete,
    };
    console.info(JSON.stringify({ event: 'playlist-sync', ...output }));
    return output;
  };
}

export const handler = createSyncPlaylistHandler(() => createPlaylistDependencies(process.env));
