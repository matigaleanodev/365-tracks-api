import { createHash } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { coreTitle } from '../../src/spotify/matching.ts';
import { artistControlKeys } from '../../src/tracks/artist-key.ts';
import { idClaimKey } from '../../src/tracks/dynamo-repository.ts';
import {
  applyControlRepair,
  auditControlRecords,
  InvalidRepairPlanError,
  planControlRepair,
  reindexControlRecords,
  type ControlRepairPlan,
} from '../../src/tracks/maintenance.ts';
import { fakeDynamo } from '../support/fake-dynamo.ts';
import { preparedTrack } from '../support/music.ts';

const band = preparedTrack('2027-01-01', 1, { artist: 'Band', title: 'Song A' });
const other = preparedTrack('2027-06-01', 2, { artist: 'Other', title: 'Song B' });
const claimKey = `id#${band.spotifyTrackId}`;
const legacyKey = `name#${'x'.repeat(500)}`;

/** Catálogo con registros de control completos y, encima, tres daños heredados. */
async function damagedTable() {
  const dynamo = fakeDynamo();
  for (const track of [band, other]) {
    dynamo.items.set(`TRACK|${track.date}`, { pk: 'TRACK', ...track });
  }
  await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
  // Reserva huérfana: a nombre de una fecha sin canción.
  dynamo.items.set(`CLAIM|${claimKey}`, { pk: 'CLAIM', date: claimKey, trackDate: '2027-01-03' });
  // Clave de artista heredada, con fechas, que ninguna canción produce.
  dynamo.items.set(`ARTIST|${legacyKey}`, {
    pk: 'ARTIST',
    date: legacyKey,
    dates: ['2027-01-01'],
    version: 1,
  });
  // Registro de artista con una fecha huérfana.
  dynamo.items.set('ARTIST|name#other', {
    pk: 'ARTIST',
    date: 'name#other',
    dates: ['2027-06-01', '2027-09-09'],
    version: 2,
  });
  return dynamo;
}

const snapshot = (dynamo: ReturnType<typeof fakeDynamo>) =>
  structuredClone([...dynamo.items.entries()].sort(([a], [b]) => a.localeCompare(b)));

describe('reparación de registros de control', () => {
  it('planifica, aplica y deja la tabla auditable sin tocar ningún TRACK', async () => {
    const dynamo = await damagedTable();
    expect(
      (await reindexControlRecords(dynamo.client, dynamo.table, { write: true })).blocked,
    ).toBe(true);
    const tracksBefore = structuredClone(dynamo.tracks());

    const plan = planControlRepair(await auditControlRecords(dynamo.client, dynamo.table));
    expect(plan.unresolved).toEqual([]);
    expect(plan.ops.map((op) => `${op.action} ${op.pk}|${op.key}`).sort()).toEqual(
      [`delete CLAIM|${claimKey}`, `delete ARTIST|${legacyKey}`, 'put ARTIST|name#other'].sort(),
    );
    expect(plan.ops.every((op) => op.pk !== ('TRACK' as string))).toBe(true);

    // El plan viaja como archivo JSON: se aplica exactamente lo revisado.
    const reviewed = JSON.parse(JSON.stringify(plan)) as ControlRepairPlan;
    expect(await applyControlRepair(dynamo.client, dynamo.table, reviewed)).toEqual({
      status: 'applied',
      applied: 3,
      batches: 1,
    });
    expect(dynamo.items.has(`ARTIST|${legacyKey}`)).toBe(false);
    expect(dynamo.items.get('ARTIST|name#other')).toMatchObject({
      dates: ['2027-06-01'],
      version: 3,
    });

    const completed = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(completed).toMatchObject({ conflicts: [], blocked: false, written: 1 });
    expect(dynamo.items.get(`CLAIM|${claimKey}`)?.trackDate).toBe('2027-01-01');
    const again = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(again).toMatchObject({ conflicts: [], blocked: false, written: 0 });
    expect(dynamo.tracks()).toEqual(tracksBefore);
  });

  it.each([
    [
      'cambia la fecha de la reserva huérfana',
      (dynamo: ReturnType<typeof fakeDynamo>) =>
        dynamo.items.set(`CLAIM|${claimKey}`, {
          pk: 'CLAIM',
          date: claimKey,
          trackDate: '2027-01-04',
        }),
    ],
    [
      'sube la versión de un registro de artista',
      (dynamo: ReturnType<typeof fakeDynamo>) =>
        dynamo.items.set('ARTIST|name#other', {
          pk: 'ARTIST',
          date: 'name#other',
          dates: ['2027-06-01', '2027-09-09'],
          version: 3,
        }),
    ],
    [
      'borra la clave heredada',
      (dynamo: ReturnType<typeof fakeDynamo>) => dynamo.items.delete(`ARTIST|${legacyKey}`),
    ],
  ])('si alguien %s entre el plan y la aplicación no aplica nada', async (_, mutate) => {
    const dynamo = await damagedTable();
    const plan = planControlRepair(await auditControlRecords(dynamo.client, dynamo.table));
    mutate(dynamo);
    const before = snapshot(dynamo);
    expect(await applyControlRepair(dynamo.client, dynamo.table, plan)).toEqual({
      status: 'control-changed',
      appliedBatches: 0,
      appliedOps: 0,
      failedBatch: 1,
    });
    expect(snapshot(dynamo)).toEqual(before);
  });

  it('rechaza un plan con operaciones sobre TRACK u otras inválidas sin escribir', async () => {
    const dynamo = await damagedTable();
    const before = snapshot(dynamo);
    const sent = dynamo.transactions.mock.calls.length;
    const valid = {
      action: 'delete',
      pk: 'CLAIM',
      key: claimKey,
      reason: 'x',
      expect: { trackDate: '2027-01-03' },
    };
    const bad: unknown[] = [
      {
        ops: [valid, { action: 'delete', pk: 'TRACK', key: '2027-01-01', reason: 'x', expect: {} }],
      },
      { ops: [{ ...valid, expect: {} }] },
      { ops: [{ action: 'delete', pk: 'ARTIST', key: 'name#a', reason: 'x', expect: {} }] },
      {
        ops: [{ action: 'put', pk: 'ARTIST', key: 'name#a', reason: 'x', expect: { version: 1 } }],
      },
      { ops: [{ ...valid, action: 'put' }] },
      { ops: [valid, valid] },

      { nada: true },
    ];
    for (const plan of bad) {
      await expect(
        applyControlRepair(dynamo.client, dynamo.table, plan as ControlRepairPlan),
      ).rejects.toThrow(InvalidRepairPlanError);
    }
    expect(dynamo.transactions.mock.calls.length).toBe(sent);
    expect(snapshot(dynamo)).toEqual(before);
  });

  it('los repetidos entre canciones y reservas de una fecha que deriva la clave quedan sin resolver', async () => {
    const dynamo = fakeDynamo();
    const dup = preparedTrack('2027-06-01', 3, {
      artist: 'Zed',
      spotifyTrackId: band.spotifyTrackId,
    });
    for (const track of [band, dup]) {
      dynamo.items.set(`TRACK|${track.date}`, { pk: 'TRACK', ...track });
    }
    dynamo.items.set(`CLAIM|${claimKey}`, { pk: 'CLAIM', date: claimKey, trackDate: '2027-06-01' });
    const before = snapshot(dynamo);

    const plan = planControlRepair(await auditControlRecords(dynamo.client, dynamo.table));
    expect(plan.ops).toEqual([]);
    expect(plan.unresolved.join('\n')).toMatch(
      /2027-06-01 repite la canción o grabación de 2027-01-01/,
    );
    expect(plan.unresolved.join('\n')).toMatch(
      /a nombre de 2027-06-01, pero la clave la deriva la canción de 2027-01-01/,
    );
    expect(await applyControlRepair(dynamo.client, dynamo.table, plan)).toEqual({
      status: 'applied',
      applied: 0,
      batches: 0,
    });
    expect(snapshot(dynamo)).toEqual(before);
  });

  it('artistas solo de símbolos: la reserva rec# vieja y la clave name# heredada se reparan', async () => {
    const dynamo = fakeDynamo();
    const tracks = [
      preparedTrack('2027-01-01', 11, { artist: '!!!', title: 'Alpha' }),
      preparedTrack('2027-01-02', 12, { artist: '***', title: 'Beta' }),
    ];
    const oldRecKey = (title: string) =>
      `rec#${createHash('sha256')
        .update(`${coreTitle(title)}|`)
        .digest('hex')}`;
    for (const track of tracks) {
      dynamo.items.set(`TRACK|${track.date}`, { pk: 'TRACK', ...track });
      const id = idClaimKey(track.spotifyTrackId);
      dynamo.items.set(`CLAIM|${id}`, { pk: 'CLAIM', date: id, trackDate: track.date });
      const old = oldRecKey(track.title);
      dynamo.items.set(`CLAIM|${old}`, { pk: 'CLAIM', date: old, trackDate: track.date });
      const [nameKey] = artistControlKeys(track);
      dynamo.items.set(`ARTIST|${nameKey}`, {
        pk: 'ARTIST',
        date: nameKey,
        dates: [track.date],
        version: 1,
      });
    }
    dynamo.items.set('ARTIST|name#', {
      pk: 'ARTIST',
      date: 'name#',
      dates: ['2027-01-01', '2027-01-02'],
      version: 1,
    });
    const tracksBefore = structuredClone(dynamo.tracks());

    const audit = await auditControlRecords(dynamo.client, dynamo.table);
    expect(audit.findings.filter((f) => f.kind === 'orphan-claim')).toHaveLength(2);
    expect(audit.findings.filter((f) => f.kind === 'legacy-artist')).toHaveLength(1);
    expect(audit.findings.every((f) => f.kind !== 'orphan-claim' || f.key.startsWith('rec#'))).toBe(
      true,
    );
    expect(await reindexControlRecords(dynamo.client, dynamo.table, { write: true })).toMatchObject(
      { blocked: true },
    );

    const plan = JSON.parse(JSON.stringify(planControlRepair(audit))) as ControlRepairPlan;
    expect(plan.unresolved).toEqual([]);
    expect(await applyControlRepair(dynamo.client, dynamo.table, plan)).toEqual({
      status: 'applied',
      applied: 3,
      batches: 1,
    });
    const completed = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(completed).toMatchObject({ conflicts: [], blocked: false, written: 2 });
    const again = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(again).toMatchObject({ conflicts: [], blocked: false, written: 0 });
    expect(dynamo.tracks()).toEqual(tracksBefore);

    const next = preparedTrack('2027-01-03', 13, { artist: '!!!', title: 'Gamma' });
    expect(await dynamo.repository.create(next)).toBe('artist-cooldown');
  });
});

describe('aplicación en lotes y clasificación de errores', () => {
  const ORPHANS = 101;
  const orphanKey = (i: number) => `id#orphan${String(i).padStart(3, '0')}`;

  /** Tabla con una canción y 101 reservas huérfanas (a nombre de una fecha sin canción). */
  async function manyOrphans() {
    const dynamo = fakeDynamo();
    dynamo.items.set(`TRACK|${band.date}`, { pk: 'TRACK', ...band });
    await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    for (let i = 0; i < ORPHANS; i += 1) {
      const key = orphanKey(i);
      dynamo.items.set(`CLAIM|${key}`, { pk: 'CLAIM', date: key, trackDate: '2027-02-01' });
    }
    const plan = planControlRepair(await auditControlRecords(dynamo.client, dynamo.table));
    return { dynamo, plan };
  }

  /** Cliente que registra cada transacción y puede fallar la n-ésima sin ejecutarla. */
  function spy(dynamo: ReturnType<typeof fakeDynamo>, fail?: { nth: number; error: Error }) {
    const sent: TransactWriteCommand[] = [];
    const client = {
      send: (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          sent.push(command);
          if (fail && sent.length === fail.nth) return Promise.reject(fail.error);
        }
        return dynamo.client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;
    return { client, sent };
  }

  const canceled = (...codes: string[]) =>
    new TransactionCanceledException({
      message: 'canceled',
      $metadata: {},
      CancellationReasons: codes.map((Code) => ({ Code })),
    });

  it('un plan de 101 operaciones se acepta y se envía en 2 transacciones (100 + 1)', async () => {
    const { dynamo, plan } = await manyOrphans();
    expect(plan.ops).toHaveLength(ORPHANS);
    const { client, sent } = spy(dynamo);

    expect(await applyControlRepair(client, dynamo.table, plan)).toEqual({
      status: 'applied',
      applied: ORPHANS,
      batches: 2,
    });
    expect(sent.map((command) => command.input.TransactItems?.length)).toEqual([100, 1]);
    for (const item of sent.flatMap((command) => command.input.TransactItems ?? [])) {
      expect(item.Delete?.ConditionExpression).toBe('trackDate = :heldBy');
      expect(item.Delete?.ExpressionAttributeValues).toEqual({ ':heldBy': '2027-02-01' });
    }
    const clean = await reindexControlRecords(dynamo.client, dynamo.table, { write: true });
    expect(clean).toMatchObject({ conflicts: [], blocked: false, written: 0 });
  });

  it('una condición que falla en el lote 2 da control-changed: el lote 1 queda aplicado', async () => {
    const { dynamo, plan } = await manyOrphans();
    const last = orphanKey(ORPHANS - 1);
    dynamo.items.set(`CLAIM|${last}`, { pk: 'CLAIM', date: last, trackDate: '2027-02-02' });

    expect(await applyControlRepair(dynamo.client, dynamo.table, plan)).toEqual({
      status: 'control-changed',
      appliedBatches: 1,
      appliedOps: 100,
      failedBatch: 2,
    });
    const left = [...dynamo.items.keys()].filter((key) => key.startsWith('CLAIM|id#orphan'));
    expect(left).toEqual([`CLAIM|${last}`]);
    expect(dynamo.items.get(`CLAIM|${last}`)?.trackDate).toBe('2027-02-02');
  });

  it.each(['ThrottlingError', 'ValidationError', 'TransactionConflict'])(
    'una cancelación solo con %s no es control-changed: lanza con la causa original',
    async (code) => {
      const { dynamo, plan } = await manyOrphans();
      const original = canceled('None', code);
      const { client } = spy(dynamo, { nth: 2, error: original });

      const error = await applyControlRepair(client, dynamo.table, plan).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(original);
      expect((error as Error).message).toMatch(
        /batch 2 of 2 failed \(1 batches and 100 operations already applied\)/,
      );
      // El lote 1 se aplicó; el lote 2 quedó intacto.
      const left = [...dynamo.items.keys()].filter((key) => key.startsWith('CLAIM|id#orphan'));
      expect(left).toEqual([`CLAIM|${orphanKey(ORPHANS - 1)}`]);
    },
  );

  it('un ValidationException del SDK se lanza envuelto, con cause igual al original', async () => {
    const { dynamo, plan } = await manyOrphans();
    const original = Object.assign(new Error('Item size too large'), {
      name: 'ValidationException',
    });
    const { client } = spy(dynamo, { nth: 1, error: original });

    const error = await applyControlRepair(client, dynamo.table, plan).catch((e: unknown) => e);
    expect((error as Error).cause).toBe(original);
    expect((error as Error).message).toMatch(/batch 1 of 2 failed \(0 batches and 0 operations/);
    expect([...dynamo.items.keys()].filter((k) => k.startsWith('CLAIM|id#orphan'))).toHaveLength(
      ORPHANS,
    );
  });

  it('razones mixtas [None, ConditionalCheckFailed] son control-changed', async () => {
    const { dynamo, plan } = await manyOrphans();
    const { client } = spy(dynamo, { nth: 1, error: canceled('None', 'ConditionalCheckFailed') });

    expect(await applyControlRepair(client, dynamo.table, plan)).toEqual({
      status: 'control-changed',
      appliedBatches: 0,
      appliedOps: 0,
      failedBatch: 1,
    });
  });
});
