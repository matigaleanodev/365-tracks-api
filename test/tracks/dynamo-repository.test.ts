import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
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
  it('escribe de forma condicional para no pisar una fecha existente', async () => {
    const { repository, send } = setup(() => ({}));

    await expect(repository.create(track('2027-01-01'))).resolves.toBe('created');

    const command = send.mock.calls[0]?.[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toEqual({
      TableName: TABLE,
      Item: { pk: 'TRACK', ...track('2027-01-01') },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('traduce la condición fallida a already-exists', async () => {
    const { repository } = setup(
      () => new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
    );
    await expect(repository.create(track('2027-01-01'))).resolves.toBe('already-exists');
  });

  it('propaga cualquier otro error', async () => {
    const { repository } = setup(() => new Error('throttled'));
    await expect(repository.create(track('2027-01-01'))).rejects.toThrow('throttled');
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
