// Mantenimiento de los registros de control del catálogo (reservas y artistas). Uso:
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts reindex            (audita: no escribe)
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts reindex --write    (completa lo que falte)
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts repair --plan-out=plan.json  (plan: no escribe)
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts repair --plan=plan.json --write  (aplica ese plan)
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts remove --date=2099-12-31 --write
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts replace --date=2027-03-01 --file=nueva.json [--write]
// `remove` y `replace` rechazan fechas que ya empezaron en alguna zona (UTC+14).
//   AWS_PROFILE=<perfil> node scripts/maintenance.ts edit-description --date=2027-03-01 \
//     --description-file=nueva.txt [--expected-file=actual.txt] [--write]   (sin --write: compara)
// Correr con TODOS los escritores detenidos (schedules, load-track): la auditoría es una instantánea. `reindex` es obligatorio antes de habilitar los
// escritores si la tabla ya tenía canciones. Nunca borra ni reasigna: informa los conflictos.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, TABLE_NAME } from '../infra/delivery.ts';
import { findDescriptionIssues } from '../src/tracks/description.ts';
import { editTrackDescription } from '../src/tracks/edit-description.ts';
import { DynamoTrackRepository } from '../src/tracks/dynamo-repository.ts';
import { replaceTrack } from '../src/tracks/replace-track.ts';
import { TRACKS_PARTITION } from '../src/tracks/dynamo-repository.ts';
import {
  applyControlRepair,
  auditControlRecords,
  InvalidRepairPlanError,
  MAX_TRANSACTION_ITEMS,
  parseControlRepairPlan,
  planControlRepair,
  reindexControlRecords,
  removeTrack,
} from '../src/tracks/maintenance.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    write: { type: 'boolean', default: false },
    date: { type: 'string' },
    'description-file': { type: 'string' },
    'expected-file': { type: 'string' },
    plan: { type: 'string' },
    file: { type: 'string' },
    'plan-out': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command] = positionals;
if (
  command !== 'reindex' &&
  command !== 'repair' &&
  command !== 'remove' &&
  command !== 'replace' &&
  command !== 'edit-description'
) {
  fail(
    'Usage: node scripts/maintenance.ts <reindex|repair [--plan-out=PATH|--plan=PATH]|remove --date=YYYY-MM-DD|replace --date=YYYY-MM-DD --file=PATH|edit-description --date=YYYY-MM-DD --description-file=PATH> [--write]',
  );
}
const profile = process.env.AWS_PROFILE;
if (!profile) fail('Set AWS_PROFILE to an authorized profile: ambient credentials are not used.');

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
console.log(
  `target: ${TABLE_NAME} (${REGION}, profile ${profile}) — ${values.write ? 'WRITE' : 'dry run'}`,
);

if (command === 'reindex') {
  const report = await reindexControlRecords(client, TABLE_NAME, { write: values.write });
  console.log(JSON.stringify(report, null, 2));
  if (report.blocked)
    console.error('Conflicts found: nothing was written. Resolve them and rerun.');
  process.exit(report.conflicts.length > 0 ? 2 : 0);
}

if (command === 'repair') {
  const planFile = values.plan;
  if (values.write && !planFile) fail('repair --write needs the reviewed plan: --plan=<file>');
  let plan;
  try {
    plan = planFile
      ? parseControlRepairPlan(JSON.parse(readFileSync(planFile, 'utf8')))
      : planControlRepair(await auditControlRecords(client, TABLE_NAME));
  } catch (error) {
    if (error instanceof InvalidRepairPlanError || error instanceof SyntaxError) {
      fail(error.message);
    }
    throw error;
  }
  if (values['plan-out']) writeFileSync(values['plan-out'], `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));
  if (values.write) {
    let result;
    try {
      result = await applyControlRepair(client, TABLE_NAME, plan);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (result.status === 'control-changed') {
      console.error(
        `control-changed: records changed since the audit (batch ${result.failedBatch} failed). Applied before stopping: ${result.appliedBatches} batches, ${result.appliedOps} operations. Run a new audit and generate a new plan.`,
      );
      process.exit(3);
    }
    console.log(`applied: ${result.applied} operations in ${result.batches} batches`);
  } else {
    const batches = Math.ceil(plan.ops.length / MAX_TRANSACTION_ITEMS);
    console.log(
      `dry run: ${plan.ops.length} operations in ${batches} batches; review the plan and apply it with --plan=<file> --write`,
    );
  }
  if (plan.unresolved.length > 0) {
    console.error('Unresolved items need `remove` or an editorial decision (see "unresolved").');
  }
  process.exit(plan.unresolved.length > 0 ? 2 : 0);
}

const date = values.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date=YYYY-MM-DD is required');

if (command === 'edit-description') {
  const descriptionFile = values['description-file'];
  if (!descriptionFile) fail('--description-file=<path> is required');
  // Archivos UTF-8 en vez de argumentos: evitan problemas de comillas del shell.
  const readText = (path: string) => readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  const newDescription = readText(descriptionFile);
  const expectedFile = values['expected-file'];
  const expectedDescription = expectedFile ? readText(expectedFile) : undefined;

  if (!values.write) {
    const { Item } = await client.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: TRACKS_PARTITION, date },
        ConsistentRead: true,
      }),
    );
    if (!Item) fail(`not-found · ${date}`);
    const issues = findDescriptionIssues(newDescription);
    console.log(`current:  ${String(Item.description)}\nnew:      ${newDescription}`);
    console.log(
      issues.length > 0 ? `invalid: ${issues.join('; ')}` : 'valid: add --write to apply',
    );
    process.exit(issues.length > 0 ? 1 : 0);
  }

  const result = await editTrackDescription(client, TABLE_NAME, {
    date,
    newDescription,
    ...(expectedDescription !== undefined && { expectedDescription }),
  });
  console.log(`${result.status} · ${date}`);
  if (result.status === 'invalid') console.error(result.issues.join('; '));
  if (result.status === 'conflict') {
    console.error(
      'The published description changed or differs from the expected one: nothing was written.',
    );
  }
  if (result.status === 'updated') console.log(`previous: ${String(result.previous)}`);
  process.exit(
    result.status === 'conflict'
      ? 3
      : result.status === 'updated' || result.status === 'unchanged'
        ? 0
        : 1,
  );
}

const publishedMessage = `${date} already started in some time zone: it is public and cannot be removed or replaced (only edit-description).`;

if (command === 'replace') {
  const file = values.file;
  if (!file) fail('--file=<track.json> is required (same format as load-track)');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await replaceTrack({
    client,
    tableName: TABLE_NAME,
    repository: new DynamoTrackRepository(client, TABLE_NAME),
    date,
    raw,
    now: new Date(),
    clock: () => new Date(),
    write: values.write,
  });
  switch (result.status) {
    case 'invalid':
      fail(`invalid (nothing written):\n${result.errors.map((e) => `- ${e}`).join('\n')}`);
      break;
    case 'published':
      fail(publishedMessage);
      break;
    case 'not-found':
      fail(`not-found · ${date}: nothing to replace; use load-track to fill an empty date.`);
      break;
    case 'valid':
      console.log(
        `current:  ${result.previous.title} — ${result.previous.artist} (${result.previous.spotifyTrackId})`,
      );
      console.log(
        `new:      ${result.track.title} — ${result.track.artist} (${result.track.spotifyTrackId})`,
      );
      console.log('valid: add --write to replace (repetition rules are checked when writing).');
      break;
    case 'replaced':
      console.log(`replaced · ${date}: ${result.previous.title} → ${result.track.title}`);
      break;
    case 'conflict':
    case 'error': {
      console.error(
        result.status === 'conflict'
          ? `conflict (new track not saved): ${result.errors.join('; ')}`
          : `error while replacing (the removal or the new save may or may not have been applied): ${result.error}`,
      );
      const occupant = {
        new: `${date} now holds the NEW track.`,
        previous: `${date} holds the previous track.`,
        empty: `${date} is EMPTY: reload the previous track with load-track.`,
        other: `${date} holds a different track (another writer): review it with catalog.ts list.`,
        unknown: `could not read ${date}: check it with catalog.ts list before doing anything else.`,
      }[result.now];
      fail(occupant);
    }
  }
  process.exit(0);
}

if (!values.write)
  fail('remove deletes data: add --write to confirm (point-in-time recovery is on).');
const removed = await removeTrack(client, TABLE_NAME, date);
if (removed === 'published') fail(publishedMessage);
console.log(`${removed} · ${date}`);
