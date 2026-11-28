import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARTISTS_PARTITION,
  CLAIMS_PARTITION,
  DynamoTrackRepository,
  TRACKS_PARTITION,
} from '../src/tracks/dynamo-repository.ts';
import { replaceTrack } from '../src/tracks/replace-track.ts';
import type { DailyTrack } from '../src/tracks/types.ts';
import { editTrackDescription } from '../src/tracks/edit-description.ts';
import {
  applyControlRepair,
  auditControlRecords,
  planControlRepair,
  reindexControlRecords,
  removeTrack,
} from '../src/tracks/maintenance.ts';
import { createDocClient, interceptSend, snapshotTable } from './support/aws.ts';
import {
  BASE_DATE,
  DESCRIPTION,
  addDays,
  claimKeysOf,
  putClaim,
  putLegacyTrack,
  track,
  useTables,
} from './support/fixtures.ts';

const newTable = useTables();
/** Reloj previo al lanzamiento: la baja rechaza fechas que ya empezaron en alguna zona. */
const BEFORE_LAUNCH = new Date('2026-12-01T00:00:00Z');
const extraClients: DynamoDBDocumentClient[] = [];
afterAll(() => extraClients.forEach((client) => client.destroy()));
const otherClient = () => {
  const client = createDocClient();
  extraClients.push(client);
  return client;
};
const partition = (items: Record<string, unknown>[], pk: string) =>
  items.filter((item) => item.pk === pk);
const NEW_DESCRIPTION =
  'Una versión más pausada, con teclados cálidos y un estribillo muy abierto.';
const OTHER_DESCRIPTION =
  'Un tema de ritmo constante, voces superpuestas y un final que se apaga solo.';

describe('auditoría con lecturas fuertes', () => {
  it('pide todas las lecturas con ConsistentRead y devuelve un resultado correcto', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    for (const n of [1, 2, 3]) {
      expect(await repo.create(track(addDays(BASE_DATE, n * 100), n))).toBe('created');
    }
    const log = interceptSend(client);
    const audit = await auditControlRecords(client, tableName);
    expect(audit).toMatchObject({
      tracks: 3,
      conflicts: [],
      emptyArtistRecords: [],
      missingClaims: [],
      staleArtists: [],
      findings: [],
      unresolved: [],
    });
    const queries = log.sent.filter((command) => command instanceof QueryCommand);
    expect(queries.map((q) => q.input.ExpressionAttributeValues?.[':pk']).sort()).toEqual([
      ARTISTS_PARTITION,
      CLAIMS_PARTITION,
      TRACKS_PARTITION,
    ]);
    expect(queries.every((query) => query.input.ConsistentRead === true)).toBe(true);

    // Las demás operaciones de mantenimiento y de escritura también leen con consistencia fuerte.
    const reads = interceptSend(client);
    await repo.create(track(addDays(BASE_DATE, 400), 4));
    await editTrackDescription(client, tableName, {
      date: addDays(BASE_DATE, 100),
      newDescription: NEW_DESCRIPTION,
    });
    await removeTrack(client, tableName, addDays(BASE_DATE, 300), { now: BEFORE_LAUNCH });
    const gets = reads.sent.filter((command) => command instanceof GetCommand);
    expect(gets.length).toBeGreaterThan(5);
    expect(gets.every((get) => get.input.ConsistentRead === true)).toBe(true);
  });

  it('audita completa una partición de más de 1 MB', async () => {
    const { client, tableName } = await newTable();
    const pad = 'x'.repeat(380_000);
    for (const n of [1, 2, 3]) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: TRACKS_PARTITION, ...track(addDays(BASE_DATE, n * 100), n), pad },
        }),
      );
    }
    // DynamoDB Local no corta las páginas a 1 MB como AWS: aquí solo se comprueba que una partición
    // grande se audita completa; el seguimiento de LastEvaluatedKey sigue cubierto por el doble.
    const audit = await auditControlRecords(client, tableName);
    expect(audit.tracks).toBe(3);
  });
});

describe('reindexación de canciones antiguas sin reservas', () => {
  it('informa en dry-run, escribe con write, es idempotente y deja las reservas operativas', async () => {
    const { client, tableName } = await newTable();
    const legacy = [
      track(BASE_DATE, 1, { artist: 'Antiguo Uno' }),
      track(addDays(BASE_DATE, 100), 2, {
        artist: 'Antiguo Dos',
        spotifyArtistId: 'artist00000000000000AA',
      }),
      track(addDays(BASE_DATE, 200), 3, {
        artist: 'Antiguo Tres',
        spotifyArtistId: 'artist00000000000000BB',
      }),
    ];
    for (const value of legacy) await putLegacyTrack(client, tableName, value);

    // 3 canciones x 2 reservas + 3 nombres + 2 IDs de artista = 11 registros.
    const dry = await reindexControlRecords(client, tableName, { write: false });
    expect(dry).toMatchObject({ tracks: 3, written: 11, conflicts: [], blocked: false });
    expect(partition(await snapshotTable(client, tableName), CLAIMS_PARTITION)).toHaveLength(0);

    const applied = await reindexControlRecords(client, tableName, { write: true });
    expect(applied).toMatchObject({ written: 11, blocked: false });
    const items = await snapshotTable(client, tableName);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(6);
    expect(partition(items, ARTISTS_PARTITION)).toHaveLength(5);
    expect(await reindexControlRecords(client, tableName, { write: true })).toMatchObject({
      written: 0,
      blocked: false,
    });
    expect((await auditControlRecords(client, tableName)).conflicts).toEqual([]);

    // Las reservas creadas ya protegen el catálogo antiguo.
    const repo = new DynamoTrackRepository(client, tableName);
    const reuseId = track(addDays(BASE_DATE, 300), 9, {
      spotifyTrackId: legacy[0]!.spotifyTrackId,
    });
    expect(await repo.create(reuseId)).toBe('duplicate-track');
    const sameArtist = track(addDays(BASE_DATE, 120), 10, { artist: 'Antiguo Dos' });
    expect(await repo.create(sameArtist)).toBe('artist-cooldown');
    const byId = track(addDays(BASE_DATE, 220), 11, {
      artist: 'Otra Grafía',
      spotifyArtistId: 'artist00000000000000BB',
    });
    expect(await repo.create(byId)).toBe('artist-cooldown');
  });

  it('con repetidos reales bloquea y no escribe nada ni con write', async () => {
    const { client, tableName } = await newTable();
    await putLegacyTrack(client, tableName, track(BASE_DATE, 1));
    await putLegacyTrack(
      client,
      tableName,
      track(addDays(BASE_DATE, 100), 2, { spotifyTrackId: track(BASE_DATE, 1).spotifyTrackId }),
    );
    const before = await snapshotTable(client, tableName);
    const report = await reindexControlRecords(client, tableName, { write: true });
    expect(report.blocked).toBe(true);
    expect(report.conflicts.join('\n')).toMatch(/repite la canción/);
    expect(await snapshotTable(client, tableName)).toEqual(before);
  });
});

describe('reservas huérfanas y titulares incorrectos', () => {
  it('detecta y repara reservas huérfanas y registros de artista heredados', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const kept = track(BASE_DATE, 1);
    expect(await repo.create(kept)).toBe('created');
    await putClaim(client, tableName, 'id#huerfana', '2026-05-05');
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: ARTISTS_PARTITION, date: 'name#heredado', dates: ['2026-05-05'], version: 3 },
      }),
    );
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: ARTISTS_PARTITION,
          date: 'name#vaciado', // sin fechas y sin canción que lo produzca: inofensivo
          dates: [],
          version: 1,
        },
      }),
    );
    const audit = await auditControlRecords(client, tableName);
    expect(audit.findings.map((f) => f.kind).sort()).toEqual(['legacy-artist', 'orphan-claim']);
    expect(audit.emptyArtistRecords).toHaveLength(1);
    expect(audit.unresolved).toEqual([]);

    const plan = planControlRepair(audit);
    expect(plan.ops.map((op) => `${op.action}:${op.pk}`).sort()).toEqual([
      'delete:ARTIST',
      'delete:CLAIM',
    ]);
    expect(await applyControlRepair(client, tableName, plan)).toEqual({
      status: 'applied',
      applied: 2,
      batches: 1,
    });
    const after = await auditControlRecords(client, tableName);
    expect(after.findings).toEqual([]);
    expect(after.conflicts).toEqual([]);
  });

  it('detecta un titular incorrecto, lo repara y reindexa la reserva correcta', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const first = track(BASE_DATE, 1);
    const second = track(addDays(BASE_DATE, 100), 2);
    expect(await repo.create(first)).toBe('created');
    expect(await repo.create(second)).toBe('created');
    // La reserva de ID de la primera canción figura a nombre de otra fecha que sí existe.
    await putClaim(client, tableName, claimKeysOf(first).id, second.date);

    const audit = await auditControlRecords(client, tableName);
    expect(audit.findings).toEqual([
      expect.objectContaining({ kind: 'orphan-claim', heldBy: second.date }),
    ]);
    expect(audit.conflicts.length).toBeGreaterThanOrEqual(1);
    // Mientras esté así, la reindexación se bloquea.
    expect((await reindexControlRecords(client, tableName, { write: true })).blocked).toBe(true);

    expect(await applyControlRepair(client, tableName, planControlRepair(audit))).toMatchObject({
      status: 'applied',
      applied: 1,
    });
    expect(await reindexControlRecords(client, tableName, { write: true })).toMatchObject({
      written: 1,
      blocked: false,
    });
    const claim = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: CLAIMS_PARTITION, date: claimKeysOf(first).id },
        ConsistentRead: true,
      }),
    );
    expect(claim.Item?.trackDate).toBe(first.date);
    expect((await auditControlRecords(client, tableName)).conflicts).toEqual([]);
  });

  it('los repetidos entre canciones quedan sin resolver y no se autocorrigen', async () => {
    const { client, tableName } = await newTable();
    const first = track(BASE_DATE, 1);
    const clone = track(addDays(BASE_DATE, 200), 2, { spotifyTrackId: first.spotifyTrackId });
    await putLegacyTrack(client, tableName, first);
    await putLegacyTrack(client, tableName, clone);
    await putClaim(client, tableName, claimKeysOf(first).id, clone.date);
    const audit = await auditControlRecords(client, tableName);
    expect(audit.unresolved.length).toBeGreaterThanOrEqual(1);
    expect(planControlRepair(audit).ops).toEqual([]);
    expect(planControlRepair(audit).unresolved).toEqual(audit.unresolved);
  });
});

describe('reparación por lotes', () => {
  async function seedOrphans(client: DynamoDBDocumentClient, tableName: string, count: number) {
    for (let start = 0; start < count; start += 25) {
      await Promise.all(
        Array.from({ length: Math.min(25, count - start) }, (_, k) =>
          putClaim(client, tableName, `id#huerfana${start + k}`, '2026-05-05'),
        ),
      );
    }
  }

  it('reanuda tras un fallo real a mitad de applyControlRepair', async () => {
    const { client, tableName } = await newTable();
    await seedOrphans(client, tableName, 105);
    const plan = planControlRepair(await auditControlRecords(client, tableName));
    expect(plan.ops).toHaveLength(105);

    // El primer lote (100 ítems) llega a DynamoDB Local; el segundo falla con un error de red.
    const failing = otherClient();
    interceptSend(failing, (command, log) => {
      if (
        command instanceof TransactWriteCommand &&
        log.sent.some((sent) => sent instanceof TransactWriteCommand)
      ) {
        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      }
    });
    const error = await applyControlRepair(failing, tableName, plan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /Repair batch 2 of 2 failed \(1 batches and 100 operations already applied\)/,
    );
    expect(((error as Error).cause as Error).message).toBe('socket hang up');
    expect(partition(await snapshotTable(client, tableName), CLAIMS_PARTITION)).toHaveLength(5);

    // El plan viejo ya no coincide con el estado real: se detiene en el primer lote sin escribir.
    expect(await applyControlRepair(client, tableName, plan)).toEqual({
      status: 'control-changed',
      appliedBatches: 0,
      appliedOps: 0,
      failedBatch: 1,
    });
    // Recuperación: auditar de nuevo, nuevo plan, aplicar lo que queda.
    const resumed = planControlRepair(await auditControlRecords(client, tableName));
    expect(resumed.ops).toHaveLength(5);
    expect(await applyControlRepair(client, tableName, resumed)).toEqual({
      status: 'applied',
      applied: 5,
      batches: 1,
    });
    expect((await auditControlRecords(client, tableName)).conflicts).toEqual([]);
  });

  it('un cambio concurrente cancela el lote completo (control-changed, sin cambios parciales)', async () => {
    const { client, tableName } = await newTable();
    await seedOrphans(client, tableName, 3);
    const plan = planControlRepair(await auditControlRecords(client, tableName));
    // Otro operador reasigna una de las reservas entre la auditoría y la aplicación.
    await putClaim(client, tableName, 'id#huerfana1', '2026-06-06');
    const before = await snapshotTable(client, tableName);
    expect(await applyControlRepair(client, tableName, plan)).toEqual({
      status: 'control-changed',
      appliedBatches: 0,
      appliedOps: 0,
      failedBatch: 1,
    });
    expect(await snapshotTable(client, tableName)).toEqual(before);
  });
});

describe('edición condicional de descripciones', () => {
  it('cubre actualización, sin cambios, no encontrada, inválida y esperada distinta', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const original = track(BASE_DATE, 1);
    expect(await repo.create(original)).toBe('created');
    const edit = (input: Parameters<typeof editTrackDescription>[2]) =>
      editTrackDescription(client, tableName, input);

    expect(await edit({ date: addDays(BASE_DATE, 5), newDescription: NEW_DESCRIPTION })).toEqual({
      status: 'not-found',
    });
    expect(await edit({ date: BASE_DATE, newDescription: 'corta' })).toMatchObject({
      status: 'invalid',
    });
    expect(await repo.getByDate(BASE_DATE)).toEqual(original);
    expect(
      await edit({ date: BASE_DATE, expectedDescription: 'otra', newDescription: NEW_DESCRIPTION }),
    ).toEqual({ status: 'conflict' });
    expect(await edit({ date: BASE_DATE, newDescription: DESCRIPTION })).toEqual({
      status: 'unchanged',
    });
    expect(
      await edit({
        date: BASE_DATE,
        expectedDescription: DESCRIPTION,
        newDescription: `  ${NEW_DESCRIPTION}  `,
      }),
    ).toEqual({ status: 'updated', previous: DESCRIPTION });
    expect(await repo.getByDate(BASE_DATE)).toEqual({ ...original, description: NEW_DESCRIPTION });
  });

  it('rechaza ediciones concurrentes: gana una sola', async () => {
    const { client, tableName } = await newTable();
    await new DynamoTrackRepository(client, tableName).create(track(BASE_DATE, 1));
    const results = await Promise.all(
      [NEW_DESCRIPTION, OTHER_DESCRIPTION].map((newDescription) =>
        editTrackDescription(otherClient(), tableName, {
          date: BASE_DATE,
          expectedDescription: DESCRIPTION,
          newDescription,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'updated']);
    const winner = results[0]?.status === 'updated' ? NEW_DESCRIPTION : OTHER_DESCRIPTION;
    expect(
      (await new DynamoTrackRepository(client, tableName).getByDate(BASE_DATE))?.description,
    ).toBe(winner);
  });

  it('la condición del UpdateItem detecta un cambio entre la lectura y la escritura', async () => {
    const { client, tableName } = await newTable();
    await new DynamoTrackRepository(client, tableName).create(track(BASE_DATE, 1));
    const victim = otherClient();
    const rival = otherClient();
    let injected = false;
    interceptSend(victim, async (command) => {
      if (command instanceof UpdateCommand && !injected) {
        injected = true;
        expect(
          await editTrackDescription(rival, tableName, {
            date: BASE_DATE,
            newDescription: OTHER_DESCRIPTION,
          }),
        ).toMatchObject({ status: 'updated' });
      }
    });
    // Sin `expectedDescription`: lo único que protege es la condición de la escritura.
    expect(
      await editTrackDescription(victim, tableName, {
        date: BASE_DATE,
        newDescription: NEW_DESCRIPTION,
      }),
    ).toEqual({ status: 'conflict' });
    expect(
      (await new DynamoTrackRepository(client, tableName).getByDate(BASE_DATE))?.description,
    ).toBe(OTHER_DESCRIPTION);
  });

  it('una canción sin descripción solo se completa si sigue sin ella', async () => {
    const { client, tableName } = await newTable();
    const bare = track(BASE_DATE, 1);
    delete bare.description;
    await putLegacyTrack(client, tableName, bare);
    const victim = otherClient();
    const rival = otherClient();
    let injected = false;
    interceptSend(victim, async (command) => {
      if (command instanceof UpdateCommand && !injected) {
        injected = true;
        await editTrackDescription(rival, tableName, {
          date: BASE_DATE,
          newDescription: OTHER_DESCRIPTION,
        });
      }
    });
    expect(
      await editTrackDescription(victim, tableName, {
        date: BASE_DATE,
        newDescription: NEW_DESCRIPTION,
      }),
    ).toEqual({ status: 'conflict' });
    expect(
      await editTrackDescription(client, tableName, {
        date: BASE_DATE,
        expectedDescription: OTHER_DESCRIPTION,
        newDescription: NEW_DESCRIPTION,
      }),
    ).toEqual({ status: 'updated', previous: OTHER_DESCRIPTION });
  });

  it('conserva las reservas y los artistas al modificar solo una descripción', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const value = track(BASE_DATE, 1, { spotifyArtistId: 'artist00000000000000AA' });
    expect(await repo.create(value)).toBe('created');
    const before = await snapshotTable(client, tableName);
    expect(
      await editTrackDescription(client, tableName, {
        date: BASE_DATE,
        newDescription: NEW_DESCRIPTION,
      }),
    ).toMatchObject({ status: 'updated' });
    const after = await snapshotTable(client, tableName);
    expect(partition(after, CLAIMS_PARTITION)).toEqual(partition(before, CLAIMS_PARTITION));
    expect(partition(after, ARTISTS_PARTITION)).toEqual(partition(before, ARTISTS_PARTITION));
    expect(partition(after, TRACKS_PARTITION)).toEqual([
      { ...partition(before, TRACKS_PARTITION)[0], description: NEW_DESCRIPTION },
    ]);
    // Y la canción sigue sin poder reutilizarse.
    expect(
      await repo.create(
        track(addDays(BASE_DATE, 300), 2, { spotifyTrackId: value.spotifyTrackId }),
      ),
    ).toBe('duplicate-track');
  });
});

describe('removeTrack real', () => {
  it('libera la fecha, la canción y la fecha del artista; conserva lo de otras fechas', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const artist = { artist: 'Dos Veces', spotifyArtistId: 'artist00000000000000AA' };
    const first = track(BASE_DATE, 1, artist);
    const second = track(addDays(BASE_DATE, 100), 2, artist);
    expect(await repo.create(first)).toBe('created');
    expect(await repo.create(second)).toBe('created');

    expect(await removeTrack(client, tableName, first.date, { now: BEFORE_LAUNCH })).toBe(
      'removed',
    );
    expect(await repo.getByDate(first.date)).toBeNull();
    expect(await repo.getByDate(second.date)).toEqual(second);
    const items = await snapshotTable(client, tableName);
    expect(partition(items, CLAIMS_PARTITION)).toHaveLength(2);
    const artists = partition(items, ARTISTS_PARTITION);
    expect(artists).toHaveLength(2);
    expect(artists.every((a) => JSON.stringify(a.dates) === JSON.stringify([second.date]))).toBe(
      true,
    );
    expect(artists.every((a) => a.version === 3)).toBe(true);
    expect(await removeTrack(client, tableName, first.date, { now: BEFORE_LAUNCH })).toBe(
      'not-found',
    );

    // La canción y la fecha quedan realmente libres.
    expect(await repo.create(first)).toBe('created');
    expect(await removeTrack(client, tableName, first.date, { now: BEFORE_LAUNCH })).toBe(
      'removed',
    );
    expect(await removeTrack(client, tableName, second.date, { now: BEFORE_LAUNCH })).toBe(
      'removed',
    );
    const audit = await auditControlRecords(client, tableName);
    expect(audit.tracks).toBe(0);
    expect(audit.conflicts).toEqual([]);
    expect(audit.emptyArtistRecords).toHaveLength(2);
    expect(partition(await snapshotTable(client, tableName), CLAIMS_PARTITION)).toHaveLength(0);
  });

  it('si el artista cambia durante la baja, falla sin borrar nada', async () => {
    const { client, tableName } = await newTable();
    const artist = { artist: 'Concurrente' };
    const target = track(BASE_DATE, 1, artist);
    await new DynamoTrackRepository(client, tableName).create(target);
    const remover = otherClient();
    const rival = new DynamoTrackRepository(otherClient(), tableName);
    let injected = false;
    interceptSend(remover, async (command) => {
      if (command instanceof TransactWriteCommand && !injected) {
        injected = true;
        expect(await rival.create(track(addDays(BASE_DATE, 100), 2, artist))).toBe('created');
      }
    });
    await expect(
      removeTrack(remover, tableName, target.date, { now: BEFORE_LAUNCH }),
    ).rejects.toThrow(/changed while it was being removed/);
    expect(await new DynamoTrackRepository(client, tableName).getByDate(target.date)).toEqual(
      target,
    );
    expect(partition(await snapshotTable(client, tableName), CLAIMS_PARTITION)).toHaveLength(4);
  });
});

describe('replaceTrack (operador)', () => {
  const input = (value: DailyTrack) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'createdAt'));

  it('reemplaza una fecha futura, libera la canción anterior y respeta las fechas públicas', async () => {
    const { client, tableName } = await newTable();
    const repo = new DynamoTrackRepository(client, tableName);
    const date = addDays(BASE_DATE, 59);
    const old = track(date, 1);
    expect(await repo.create(old)).toBe('created');
    const replace = (raw: unknown, now: Date) =>
      replaceTrack({ client, tableName, repository: repo, date, raw, now, write: true });

    // 10:00 UTC del día anterior: la fecha ya empezó en UTC+14 y no se toca.
    const started = new Date(`${addDays(date, -1)}T10:00:00Z`);
    expect(await replace(input(track(date, 2)), started)).toEqual({ status: 'published' });
    expect(await repo.getByDate(date)).toEqual(old);

    const result = await replace(input(track(date, 2)), BEFORE_LAUNCH);
    expect(result).toMatchObject({ status: 'replaced' });
    expect((await repo.getByDate(date))?.spotifyTrackId).toBe(track(date, 2).spotifyTrackId);
    expect(await repo.create(track(addDays(BASE_DATE, 200), 1))).toBe('created');

    // Una repetición se rechaza y la canción vigente vuelve a su fecha.
    const conflict = await replace(input(track(date, 1)), BEFORE_LAUNCH);
    expect(conflict).toMatchObject({ status: 'conflict', now: 'previous' });
    expect((await repo.getByDate(date))?.spotifyTrackId).toBe(track(date, 2).spotifyTrackId);
  });
});
