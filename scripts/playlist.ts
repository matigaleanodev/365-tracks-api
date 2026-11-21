// Sincronización manual de la playlist anual. Uso:
//   AWS_PROFILE=<perfil> node scripts/playlist.ts sync            (dry-run)
//   AWS_PROFILE=<perfil> node scripts/playlist.ts sync --write    (crea/agrega en Spotify y registra)
// Lee la tabla (DynamoDB) y las credenciales (Parameter Store) reales. El dry-run (por defecto)
// con registro guardado de la playlist del año lee la playlist real y reporta lo que agregaría;
// sin registro no consulta Spotify y el resultado es una cota superior (al escribir se reutiliza
// una playlist existente con el mismo nombre en vez de duplicarla). No modifica playlists ni
// registros de sincronización ni toma el candado; su única escritura posible es guardar en
// Parameter Store un refresh token que Spotify haya rotado (requiere ssm:PutParameter), porque
// descartarlo podría invalidar la autorización. Escribir playlists y registros exige --write.
// Solo se consideran días terminados en todas las zonas (desde las 12:00 UTC de D+1).
import { parseArgs } from 'node:util';
import { REGION, SSM_PREFIX, TABLE_NAME } from '../infra/delivery.ts';
import { createPlaylistDependencies } from '../src/jobs/dependencies.ts';
import { syncPlaylists, type SyncReport } from '../src/playlist/sync.ts';
import { SpotifyAuthError } from '../src/spotify/errors.ts';

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
if (values.write && values.now) {
  fail('--now only works in dry-run: writing always uses the real clock (eligibility and lock).');
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
  `target: ${TABLE_NAME} (${REGION}, profile ${profile}) — ${
    dryRun
      ? 'dry run: playlists and sync records are not modified (a rotated Spotify refresh token is still saved to Parameter Store)'
      : 'WRITE'
  }`,
);

let report: SyncReport;
try {
  report = await syncPlaylists({ ...dependencies, now: () => clock ?? new Date() }, { dryRun });
} catch (error) {
  if (error instanceof SpotifyAuthError && error.failure === 'rotation_not_persisted') {
    fail(
      'Spotify rotated the refresh token but it could not be saved to Parameter Store; nothing else was written. ' +
        'Check that the profile allows ssm:PutParameter on the refresh-token parameter and run again. ' +
        'If the previous token no longer works (invalid_grant), repeat the initial authorization: ' +
        'node scripts/spotify-authorize.ts --store',
    );
  }
  throw error;
}
console.log(JSON.stringify(report, null, 2));
