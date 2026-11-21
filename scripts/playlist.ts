// Sincronización manual de la playlist anual. Uso:
//   AWS_PROFILE=<perfil> node scripts/playlist.ts sync            (simulación: no escribe nada)
//   AWS_PROFILE=<perfil> node scripts/playlist.ts sync --write    (crea/agrega en Spotify y registra)
// Lee la tabla y las credenciales de Parameter Store. Por defecto es una simulación; escribir
// exige --write explícito. Solo agrega canciones de días ya terminados en todas las zonas.
import { parseArgs } from 'node:util';
import { REGION, SSM_PREFIX, TABLE_NAME } from '../infra/delivery.ts';
import { createPlaylistDependencies } from '../src/jobs/dependencies.ts';
import { syncPlaylists } from '../src/playlist/sync.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { write: { type: 'boolean', default: false }, now: { type: 'string' } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (positionals[0] !== 'sync') {
  fail('Usage: node scripts/playlist.ts sync [--write] [--now=ISO]');
}
const profile = process.env.AWS_PROFILE;
if (!profile) {
  fail('Set AWS_PROFILE to an authorized profile: ambient credentials are not used on purpose.');
}
const clock = values.now ? new Date(values.now) : undefined;
if (clock && Number.isNaN(clock.getTime())) {
  fail('--now must be an ISO 8601 instant, e.g. 2027-01-02T12:30:00Z');
}

const dependencies = await createPlaylistDependencies({
  ...process.env,
  TRACKS_TABLE_NAME: TABLE_NAME,
  SSM_PARAMETER_PREFIX: SSM_PREFIX,
  AWS_REGION: REGION,
});
const dryRun = !values.write;
console.log(
  `target: ${TABLE_NAME} (${REGION}, profile ${profile}) — ${dryRun ? 'dry run, nothing is written' : 'WRITE'}`,
);

const report = await syncPlaylists({ ...dependencies, now: () => clock ?? new Date() }, { dryRun });
console.log(JSON.stringify(report, null, 2));
