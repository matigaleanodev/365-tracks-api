// Consulta, estado y reposición manual del catálogo. Uso:
//   AWS_PROFILE=<perfil> node scripts/catalog.ts list      (todo el catálogo, solo lee)
//   AWS_PROFILE=<perfil> node scripts/catalog.ts list --json   (con la nota completa)
//   node scripts/catalog.ts status --local                 (repositorio en memoria vacío)
//   AWS_PROFILE=<perfil> node scripts/catalog.ts status    (solo lee la tabla desplegada)
//   node scripts/catalog.ts replenish --local              (ejercita la orquestación)
// `replenish` contra la tabla desplegada exige --write además de AWS_PROFILE: sin él no corre.
// `--live` usa la selección real (OpenAI + Spotify, credenciales de Parameter Store) y escribe
// canciones futuras en la tabla: exige AWS_PROFILE y --write. Sin --live, reponer ejercita la
// orquestación con selector y Spotify de mentira (informa el fallo y no escribe).
//   AWS_PROFILE=<perfil> node scripts/catalog.ts replenish --live --write --max-new=3
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { REGION, SSM_PREFIX, TABLE_NAME } from '../infra/delivery.ts';
import { createCatalogDependencies } from '../src/jobs/dependencies.ts';
import { notImplementedMusicSelector } from '../src/music-selection/index.ts';
import { notImplementedSpotifyClient } from '../src/spotify/index.ts';
import { getCatalogStatus, getCatalogWindow, replenishCatalog } from '../src/tracks/catalog.ts';
import { listCatalog } from '../src/tracks/catalog-list.ts';
import { DynamoTrackRepository } from '../src/tracks/dynamo-repository.ts';
import { InMemoryTrackRepository } from '../src/tracks/in-memory-repository.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    local: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    'max-new': { type: 'string' },
    now: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command] = positionals;
if (command !== 'list' && command !== 'status' && command !== 'replenish') {
  fail(
    'Usage: node scripts/catalog.ts <list [--json]|status|replenish> [--local] [--write] [--now=ISO]',
  );
}
const clock = values.now ? new Date(values.now) : undefined;
if (clock && Number.isNaN(clock.getTime())) {
  fail('--now must be an ISO 8601 instant, e.g. 2027-01-01T00:00:00Z');
}
const now = () => clock ?? new Date();

const profile = process.env.AWS_PROFILE;
if (!values.local && !profile) {
  fail(
    'Set AWS_PROFILE to an authorized profile, or use --local: ambient credentials are not used.',
  );
}
if (values.live && values.local) {
  fail('--live and --local are mutually exclusive.');
}
const maxNew = values['max-new'] === undefined ? undefined : Number(values['max-new']);
if (maxNew !== undefined && (!Number.isInteger(maxNew) || maxNew < 1)) {
  fail('--max-new must be a positive integer.');
}
if (values.live && command !== 'replenish') {
  fail('--live only applies to replenish.');
}
if (!values.local && command === 'replenish' && !values.write) {
  fail('replenish against the deployed table writes data: add --write to confirm.');
}

const repository = values.local
  ? new InMemoryTrackRepository()
  : new DynamoTrackRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
      TABLE_NAME,
    );
// Con --json la salida estándar queda solo para el JSON.
(values.json ? console.error : console.log)(
  values.local
    ? 'target: local (in memory)'
    : `target: ${TABLE_NAME} (${REGION}, profile ${profile})`,
);

const window = getCatalogWindow(now());
if (command === 'list') {
  const { entries, gaps } = await listCatalog(repository, now());
  if (values.json) {
    console.log(JSON.stringify({ entries, gaps }, null, 2));
  } else {
    const clip = (value: string, max: number) =>
      value.length > max ? `${value.slice(0, max - 1)}…` : value;
    for (const entry of entries) {
      const note = entry.description === undefined ? '(sin nota)' : clip(entry.description, 60);
      const missing =
        entry.missingFields.length > 0 ? ` [falta: ${entry.missingFields.join(', ')}]` : '';
      console.log(
        `${entry.date}  ${entry.status.padEnd(10)}  ${clip(`${entry.title} — ${entry.artist}`, 50).padEnd(50)}  ${entry.spotifyTrackId}  ${note}${missing}`,
      );
    }
    const count = (status: string) => entries.filter((entry) => entry.status === status).length;
    console.log(
      `total ${entries.length} · published ${count('published')} · prepared ${count('prepared')} · incomplete ${count('incomplete')}`,
    );
    console.log(`gaps (sin canción): ${gaps.join(', ') || '(none)'}`);
  }
} else if (command === 'status') {
  const status = await getCatalogStatus(repository, window);
  console.log(`window ${status.from} → ${status.to}`);
  console.log(`prepared ${status.prepared.length}/${window.length}`);
  console.log(`incomplete (need manual fix): ${status.incomplete.join(', ') || '(none)'}`);
  console.log(`missing: ${status.missing.join(', ') || '(none)'}`);
} else {
  const dependencies = values.live
    ? await createCatalogDependencies({
        ...process.env,
        TRACKS_TABLE_NAME: TABLE_NAME,
        SSM_PARAMETER_PREFIX: SSM_PREFIX,
        AWS_REGION: REGION,
      })
    : {
        repository,
        selector: notImplementedMusicSelector,
        spotify: notImplementedSpotifyClient,
        now,
      };
  const report = await replenishCatalog(
    dependencies,
    window,
    maxNew === undefined ? {} : { maxNew },
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.outcomes.some((o) => o.status === 'failed') ? 1 : 0);
}
