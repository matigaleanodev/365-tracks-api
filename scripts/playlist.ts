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
//   AWS_PROFILE=<perfil> node scripts/playlist.ts info                 (cuenta y playlists registradas)
//   AWS_PROFILE=<perfil> node scripts/playlist.ts rehearse [--write] [--playlist-id=<ensayo>] \
//     [--sample=muestra.json] [--now=2027-01-03T12:30:00Z]
// `rehearse` ensaya la sincronización real contra una playlist de prueba de la cuenta autorizada,
// con canciones de muestra en memoria: solo lee el catálogo para rechazar muestras con canciones
// todavía no publicables, no escribe la tabla, y rechaza una playlist anual registrada o de otro
// titular. Sin --playlist-id usa la playlist `Daywave - Test` de la cuenta (con --write la crea
// pública si falta). Sin --sample resuelve en Spotify una muestra integrada de tres canciones
// conocidas con fechas 2027-01-01..03; el reloj por defecto deja entrar solo las dos primeras.
// Con --write corre dos veces (la segunda no debe agregar nada).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { REGION, SSM_PREFIX, TABLE_NAME } from '../infra/delivery.ts';
import { createPlaylistDependencies } from '../src/jobs/dependencies.ts';
import { syncPlaylists, type SyncReport } from '../src/playlist/sync.ts';
import {
  BUILT_IN_SAMPLE,
  BUILT_IN_SAMPLE_DATES,
  DEFAULT_REHEARSAL_NOW,
  RehearsalRefusedError,
  rehearsePlaylistSync,
  resolveTestPlaylist,
  sampleTrack,
  TEST_PLAYLIST_NAME,
} from '../src/playlist/rehearsal.ts';
import { SSMClient } from '@aws-sdk/client-ssm';
import { PARAMETER_KEYS, readParameters, SsmParameterStore } from '../src/config/parameters.ts';
import { createClientCredentialsProvider } from '../src/spotify/auth.ts';
import { createSpotifyClient } from '../src/spotify/client.ts';
import { normalizeText } from '../src/spotify/matching.ts';
import { isEligibleForPlaylist, playlistName } from '../src/playlist/eligibility.ts';
import { readAllTracks } from '../src/tracks/read-all.ts';
import { parseTrackInput } from '../src/tracks/track-input.ts';
import type { DailyTrack } from '../src/tracks/types.ts';
import { SpotifyAuthError } from '../src/spotify/errors.ts';
import { HttpError } from '../src/shared/resilient-fetch.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: 'boolean', default: false },
    now: { type: 'string' },
    'playlist-id': { type: 'string' },
    sample: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command] = positionals;
if (command !== 'sync' && command !== 'info' && command !== 'rehearse') {
  fail(
    'Usage: node scripts/playlist.ts <sync [--write] [--now=ISO]|info|rehearse [--write] [--playlist-id=ID] [--sample=FILE] [--now=ISO]>',
  );
}
const profile = process.env.AWS_PROFILE;
if (!profile) {
  fail('Set AWS_PROFILE to an authorized profile: ambient credentials are not used on purpose.');
}
if (command === 'sync' && values.write && values.now) {
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
function handleAuthError(error: unknown): never {
  if (
    error instanceof HttpError &&
    error.status === 403 &&
    /insufficient client scope/i.test(error.body ?? '')
  ) {
    fail(
      'The Spotify authorization lacks a required scope. Authorize again (it keeps the app credentials): ' +
        'AWS_PROFILE=<profile> AWS_REGION=us-east-1 node scripts/spotify-authorize.ts --from-ssm --github-secret --store',
    );
  }
  if (error instanceof SpotifyAuthError && error.failure === 'rotation_not_persisted') {
    fail(
      'Spotify rotated the refresh token but it could not be saved to Parameter Store; nothing else was written. ' +
        'Check that the profile allows ssm:PutParameter on the refresh-token parameter and run again. ' +
        'If the previous token no longer works (invalid_grant), repeat the initial authorization: ' +
        'bash scripts/setup-github-secrets.sh (or node scripts/spotify-authorize.ts --github-secret --store)',
    );
  }
  throw error;
}

/** Años con playlist anual registrada en la tabla (2027 en adelante, hasta el año próximo). */
async function registeredPlaylists() {
  const lastYear = new Date().getUTCFullYear() + 1;
  const records = [];
  for (let year = 2027; year <= Math.max(lastYear, 2027); year += 1) {
    const record = await dependencies.state.getPlaylist(year);
    if (record) records.push(record);
  }
  return records;
}

if (command === 'info') {
  try {
    console.log(`authorized Spotify account: ${await dependencies.playlists.currentUserId()}`);
    const describe = async (label: string, id: string) => {
      const info = await dependencies.playlists.describe(id);
      const items = await dependencies.playlists.listItems(id);
      console.log(
        `${label} · ${info.id} · "${info.name}" · owner ${info.ownerId} · ${info.isPublic === false ? 'private' : 'public'} · ${items.length} items · ${info.url}`,
      );
    };
    const records = await registeredPlaylists();
    if (records.length === 0) console.log('annual playlists: (none registered yet)');
    for (const record of records) await describe(`${record.year} (registered)`, record.playlistId);
    // Playlists de la cuenta con el nombre que buscará la sincronización o el ensayo (solo lee).
    const lastYear = Math.max(new Date().getUTCFullYear() + 1, 2027);
    for (const name of [
      ...Array.from({ length: lastYear - 2026 }, (_, index) => playlistName(2027 + index)),
      TEST_PLAYLIST_NAME,
    ]) {
      const found = await dependencies.playlists.findOwnedByName(name);
      if (found) await describe(`by name "${name}"`, found.id);
      else console.log(`by name "${name}": (not found in the account)`);
    }
  } catch (error) {
    handleAuthError(error);
  }
  process.exit(0);
}

/** Resuelve la muestra integrada con las credenciales de la app (client credentials). */
async function builtInSample(now: Date): Promise<DailyTrack[]> {
  const parameters = await readParameters(
    new SsmParameterStore(new SSMClient({ region: REGION })),
    SSM_PREFIX,
    [PARAMETER_KEYS.spotifyClientId, PARAMETER_KEYS.spotifyClientSecret],
  );
  const spotify = createSpotifyClient({
    tokens: createClientCredentialsProvider({
      clientId: parameters.require(PARAMETER_KEYS.spotifyClientId),
      clientSecret: parameters.require(PARAMETER_KEYS.spotifyClientSecret),
    }),
  });
  const tracks: DailyTrack[] = [];
  for (const [index, wanted] of BUILT_IN_SAMPLE.entries()) {
    const found = (await spotify.searchTracks(wanted)).find(
      (track) => normalizeText(track.artist) === normalizeText(wanted.artist),
    );
    if (!found) fail(`built-in sample: ${wanted.title} (${wanted.artist}) not found on Spotify`);
    tracks.push(sampleTrack(found, BUILT_IN_SAMPLE_DATES[index]!, now));
  }
  return tracks;
}

function readSample(file: string): DailyTrack[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) fail('--sample must be a non-empty JSON array');
  return raw.map((entry, index) => {
    const parsed = parseTrackInput(entry, new Date());
    if (!parsed.ok) fail(`sample #${index + 1}: ${parsed.errors.join('; ')}`);
    return parsed.track;
  });
}

if (command === 'rehearse') {
  const rehearsalClock = clock ?? new Date(DEFAULT_REHEARSAL_NOW);
  let playlistId = values['playlist-id'];
  try {
    if (!playlistId) {
      const resolved = await resolveTestPlaylist(dependencies.playlists, {
        dryRun: !values.write,
      });
      if (!resolved) {
        console.log(
          `"${TEST_PLAYLIST_NAME}" does not exist yet: run with --write to create it (public) and rehearse.`,
        );
        process.exit(0);
      }
      if (resolved.created) console.log(`created public test playlist "${TEST_PLAYLIST_NAME}"`);
      playlistId = resolved.id;
    }
  } catch (error) {
    if (error instanceof RehearsalRefusedError) fail(`refused: ${error.message}`);
    handleAuthError(error);
  }
  const sample = values.sample ? readSample(values.sample) : await builtInSample(new Date());
  console.log(
    `rehearsal on test playlist ${playlistId} — ${values.write ? 'WRITE' : 'dry run'} · clock ${rehearsalClock.toISOString()}`,
  );
  try {
    const report = await rehearsePlaylistSync({
      playlists: dependencies.playlists,
      playlistId,
      protectedPlaylistIds: (await registeredPlaylists()).map((record) => record.playlistId),
      // Con el reloj real: lo que todavía no puede estar en una playlist pública.
      reservedTrackIds: (await readAllTracks(dependencies.tracks))
        .filter((track) => !isEligibleForPlaylist(track.date, new Date()))
        .map((track) => track.spotifyTrackId),
      sample,
      now: rehearsalClock,
      dryRun: !values.write,
    });
    console.log(JSON.stringify(report, null, 2));
    const duplicated = (report.second?.years ?? []).some((year) => year.added.length > 0);
    if (duplicated) fail('second pass added tracks: duplicates detected');
  } catch (error) {
    if (error instanceof RehearsalRefusedError) fail(`refused: ${error.message}`);
    handleAuthError(error);
  }
  process.exit(0);
}

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
  handleAuthError(error);
}
console.log(JSON.stringify(report, null, 2));
