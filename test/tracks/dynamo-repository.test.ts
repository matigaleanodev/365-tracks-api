import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createTrackRepository } from '../../src/tracks/create-repository.ts';
import { DynamoTrackRepository } from '../../src/tracks/dynamo-repository.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';

const TABLE = 'tracks-table';

const track = (date: string): DailyTrack => ({
  date,
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  releaseYear: 1999,
  spotifyTrackId: 'abc',
  spotifyUrl: 'https://open.spotify.com/track/abc',
  selectionCriterion: 'test',
  createdAt: '2027-01-01T00:05:00.000Z',
});

function setup(respond: (command: unknown) => unknown) {
  const send = vi.fn((command: unknown) => {
    const result = respond(command);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const repository = new DynamoTrackRepository(
    { send } as unknown as DynamoDBDocumentClient,
    TABLE,
  );
  return { repository, send };
}

describe('DynamoTrackRepository.getByDate', () => {
  it('lee por clave (pk + fecha) y no expone la clave de partición', async () => {
    const { repository, send } = setup(() => ({ Item: { pk: 'TRACK', ...track('2027-01-01') } }));

    await expect(repository.getByDate('2027-01-01')).resolves.toEqual(track('2027-01-01'));

    const command = send.mock.calls[0]?.[0] as GetCommand;
    expect(command).toBeInstanceOf(GetCommand);
    expect(command.input).toEqual({
      TableName: TABLE,
      Key: { pk: 'TRACK', date: '2027-01-01' },
      ConsistentRead: true,
    });
  });

  it('devuelve null si no existe', async () => {
    const { repository } = setup(() => ({}));
    await expect(repository.getByDate('2027-01-01')).resolves.toBeNull();
  });
});

describe('DynamoTrackRepository.list', () => {
  it('consulta en orden descendente pidiendo un ítem de más para detectar otra página', async () => {
    const items = ['2027-01-03', '2027-01-02', '2027-01-01'].map((date) => ({
      pk: 'TRACK',
      ...track(date),
    }));
    const { repository, send } = setup(() => ({ Items: items }));

    const page = await repository.list({ limit: 2 });

    expect(page.items.map((item) => item.date)).toEqual(['2027-01-03', '2027-01-02']);
    expect(page.items[0]).not.toHaveProperty('pk');
    expect(page.hasMore).toBe(true);
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toMatchObject({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'TRACK' },
      ScanIndexForward: false,
      Limit: 3,
    });
  });

  it('informa que no hay más cuando entran justo en la página', async () => {
    const { repository } = setup(() => ({ Items: [{ pk: 'TRACK', ...track('2027-01-01') }] }));
    await expect(repository.list({ limit: 1 })).resolves.toMatchObject({ hasMore: false });
  });

  it('aplica el cursor como fecha estrictamente anterior y escapa la palabra reservada date', async () => {
    const { repository, send } = setup(() => ({}));

    const page = await repository.list({ limit: 5, before: '2027-01-03' });

    expect(page).toEqual({ items: [], hasMore: false });
    const command = send.mock.calls[0]?.[0] as QueryCommand;
    expect(command.input).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND #date < :before',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':pk': 'TRACK', ':before': '2027-01-03' },
    });
  });
});

describe('DynamoTrackRepository.create', () => {
  it('escribe en una transacción: fecha, reservas de canción y grabación, y versión por artista', async () => {
    const { repository, send } = setup(() => ({}));

    await expect(repository.create(track('2027-01-01'))).resolves.toBe('created');

    const write = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const items = write.input.TransactItems ?? [];
    expect(items[0]?.Put).toEqual({
      TableName: TABLE,
      Item: { pk: 'TRACK', ...track('2027-01-01') },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(items[1]?.Put?.Item).toMatchObject({ pk: 'CLAIM', date: 'id#abc' });
    expect(items[2]?.Put?.Item).toMatchObject({ pk: 'CLAIM' });
    expect(String(items[2]?.Put?.Item?.date)).toMatch(/^rec#[0-9a-f]{64}$/);
    expect(items[3]?.Put?.Item).toEqual({
      pk: 'ARTIST',
      date: 'name#artist',
      dates: ['2027-01-01'],
      version: 1,
    });
    for (const item of items) {
      expect(item.Put?.ConditionExpression).toContain('attribute_not_exists(pk)');
    }
  });

  const canceled = (...codes: string[]) =>
    new TransactionCanceledException({
      message: 'canceled',
      $metadata: {},
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  const respondCanceled =
    (...codes: string[]) =>
    (command: unknown) =>
      command instanceof TransactWriteCommand ? canceled(...codes) : {};

  it('traduce cada condición fallida al motivo correspondiente', async () => {
    const date = setup(respondCanceled('ConditionalCheckFailed', 'None', 'None', 'None'));
    await expect(date.repository.create(track('2027-01-01'))).resolves.toBe('already-exists');
    const id = setup(respondCanceled('None', 'ConditionalCheckFailed', 'None', 'None'));
    await expect(id.repository.create(track('2027-01-01'))).resolves.toBe('duplicate-track');
    const rec = setup(respondCanceled('None', 'None', 'ConditionalCheckFailed', 'None'));
    await expect(rec.repository.create(track('2027-01-01'))).resolves.toBe('duplicate-recording');
  });

  it('rechaza al artista dentro de 60 días sin escribir', async () => {
    const { repository, send } = setup((command) =>
      command instanceof GetCommand && command.input.Key?.date === 'name#artist'
        ? { Item: { dates: ['2027-01-01'], version: 1 } }
        : {},
    );
    await expect(
      repository.create({ ...track('2027-02-01'), spotifyTrackId: 'xyz' }),
    ).resolves.toBe('artist-cooldown');
    expect(send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(false);
  });

  it('un reintento de la misma canción no es un falso conflicto de artista', async () => {
    const { repository } = setup((command) => {
      if (command instanceof GetCommand) return { Item: { dates: ['2027-01-01'], version: 1 } };
      return canceled('ConditionalCheckFailed', 'ConditionalCheckFailed', 'None', 'None');
    });
    await expect(repository.create(track('2027-01-01'))).resolves.toBe('already-exists');
  });

  it('ante contención reintenta y, si persiste, falla en vez de guardar mal', async () => {
    const { repository, send } = setup(
      respondCanceled('None', 'None', 'None', 'TransactionConflict'),
    );
    await expect(repository.create(track('2027-01-01'))).rejects.toThrow(/contention/);
    expect(send.mock.calls.filter(([c]) => c instanceof TransactWriteCommand)).toHaveLength(5);
  });

  it('una fecha ocupada tiene precedencia sobre el intervalo del artista', async () => {
    const { repository } = setup((command) => {
      if (command instanceof GetCommand && command.input.Key?.pk === 'TRACK') {
        return { Item: { pk: 'TRACK', ...track('2027-01-20') } };
      }
      if (command instanceof GetCommand) return { Item: { dates: ['2027-01-01'], version: 1 } };
      return {};
    });
    await expect(repository.create(track('2027-01-20'))).resolves.toBe('already-exists');
  });

  it('un error de validación no se reintenta y conserva la causa', async () => {
    const { repository, send } = setup(respondCanceled('None', 'None', 'ValidationError', 'None'));
    const error = await repository.create(track('2027-01-01')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ValidationError/);
    expect((error as Error).cause).toBeInstanceOf(TransactionCanceledException);
    expect(send.mock.calls.filter(([c]) => c instanceof TransactWriteCommand)).toHaveLength(1);
  });

  it('el throttling transitorio se reintenta con pausa y termina bien', async () => {
    let attempts = 0;
    const { repository } = setup((command) => {
      if (!(command instanceof TransactWriteCommand)) return {};
      attempts += 1;
      return attempts < 3 ? canceled('None', 'None', 'None', 'ThrottlingError') : {};
    });
    await expect(repository.create(track('2027-01-01'))).resolves.toBe('created');
    expect(attempts).toBe(3);
  });

  it('propaga cualquier otro error', async () => {
    const { repository } = setup(() => new Error('throttled'));
    await expect(repository.create(track('2027-01-01'))).rejects.toThrow('throttled');
  });
});

describe('DynamoTrackRepository.list con límite de 1 MB', () => {
  it('sigue leyendo con LastEvaluatedKey hasta completar la página', async () => {
    const rows = ['2027-01-04', '2027-01-03', '2027-01-02', '2027-01-01'].map((date) => ({
      pk: 'TRACK',
      ...track(date),
    }));
    const queries: unknown[] = [];
    const { repository } = setup((command) => {
      queries.push((command as QueryCommand).input);
      if (queries.length === 1) {
        return { Items: [rows[0]], LastEvaluatedKey: { pk: 'TRACK', date: '2027-01-04' } };
      }
      return { Items: rows.slice(1, 3) };
    });
    const page = await repository.list({ limit: 2 });
    expect(page.items.map((item) => item.date)).toEqual(['2027-01-04', '2027-01-03']);
    expect(page.hasMore).toBe(true);
    expect(queries[1]).toMatchObject({
      ExclusiveStartKey: { pk: 'TRACK', date: '2027-01-04' },
      Limit: 2,
    });
  });

  it('con LastEvaluatedKey y pocos ítems no declara que terminó', async () => {
    const { repository } = setup(
      (() => {
        let calls = 0;
        return () =>
          ++calls === 1
            ? {
                Items: [{ pk: 'TRACK', ...track('2027-01-02') }],
                LastEvaluatedKey: { pk: 'TRACK' },
              }
            : { Items: [{ pk: 'TRACK', ...track('2027-01-01') }] };
      })(),
    );
    const page = await repository.list({ limit: 5 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });
});

describe('createTrackRepository', () => {
  const now = new Date('2027-01-01T00:00:00Z');

  it('usa DynamoDB cuando hay tabla, aunque haya fixtures habilitados', () => {
    const repository = createTrackRepository(
      { TRACKS_TABLE_NAME: TABLE, USE_DEV_FIXTURES: 'true' },
      now,
    );
    expect(repository).toBeInstanceOf(DynamoTrackRepository);
  });

  it('usa memoria con fixtures o vacía sin tabla', async () => {
    const withFixtures = createTrackRepository({ USE_DEV_FIXTURES: 'true' }, now);
    const empty = createTrackRepository({}, now);
    expect(withFixtures).toBeInstanceOf(InMemoryTrackRepository);
    expect(empty).toBeInstanceOf(InMemoryTrackRepository);
    expect((await withFixtures.list({ limit: 10 })).items.length).toBeGreaterThan(0);
    expect((await empty.list({ limit: 10 })).items).toHaveLength(0);
  });
});
