// Carga manual de canciones en DynamoDB. Uso:
//   node scripts/load-track.ts --file cancion.json --dry-run        (un objeto JSON)
//   node scripts/load-track.ts --file mes.json --dry-run            (un array JSON: varias fechas)
//   AWS_PROFILE=<perfil> node scripts/load-track.ts --file mes.json
// `--file -` lee el JSON de la entrada estándar. Ver DEPLOYMENT.md.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { REGION, TABLE_NAME } from '../infra/delivery.ts';
import { DynamoTrackRepository } from '../src/tracks/dynamo-repository.ts';
import { importTracks } from '../src/tracks/manual-import.ts';
import { loadTrackManually } from '../src/tracks/manual-load.ts';

const { values } = parseArgs({
  options: { file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!values.file) {
  fail('Usage: node scripts/load-track.ts --file <tracks.json | -> [--dry-run]');
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(values.file === '-' ? 0 : values.file, 'utf8'));
} catch (error) {
  fail(`Cannot read ${values.file} as JSON: ${error instanceof Error ? error.message : error}`);
}

const dryRun = values['dry-run'];
const profile = process.env.AWS_PROFILE;
if (!dryRun && !profile) {
  fail('Set AWS_PROFILE to an authorized profile: ambient credentials are not used on purpose.');
}

const repository = dryRun
  ? undefined
  : new DynamoTrackRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
      TABLE_NAME,
    );
const target = dryRun ? 'dry-run' : `${TABLE_NAME} (${REGION}, profile ${profile})`;
const now = new Date();

if (Array.isArray(raw)) {
  const report = await importTracks({ raw, now, ...(repository ? { repository } : {}) });
  for (const error of report.errors) {
    console.error(`- ${error}`);
  }
  for (const record of report.records) {
    const detail = record.errors.length > 0 ? ` · ${record.errors.join('; ')}` : '';
    console.log(`#${record.position} · ${record.date ?? '(no date)'} · ${record.status}${detail}`);
  }
  const count = (status: string) => report.records.filter((r) => r.status === status).length;
  console.log(
    report.ok
      ? `OK · ${target} · created ${count('created')}, already-exists ${count('already-exists')}, valid ${count('valid')}`
      : `ABORTED · nothing written · ${target}`,
  );
  if (dryRun) {
    console.log('dry-run: only the file was validated; stored dates and ids were not checked.');
  }
  process.exit(report.ok ? 0 : 1);
}

const result = await loadTrackManually({ raw, now, ...(repository ? { repository } : {}) });

if (result.status === 'invalid') {
  console.error(
    `Invalid track (nothing written):\n${result.errors.map((e) => `- ${e}`).join('\n')}`,
  );
  process.exit(1);
}

console.log(`${result.status} · ${result.track.date} · ${target}`);
console.log(JSON.stringify(result.track, null, 2));
