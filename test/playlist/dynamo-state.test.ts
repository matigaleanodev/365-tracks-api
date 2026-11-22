import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoPlaylistState } from '../../src/playlist/dynamo-state.ts';

const setup = (respond: (command: unknown) => unknown = () => ({})) => {
  const send = vi.fn((command: unknown) => {
    const result = respond(command);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  return {
    send,
    state: new DynamoPlaylistState({ send } as unknown as DynamoDBDocumentClient, 'table'),
  };
};

describe('DynamoPlaylistState', () => {
  it('la playlist del año se guarda en una partición distinta de las canciones', async () => {
    const { state, send } = setup();
    await state.savePlaylist({
      year: 2027,
      playlistId: 'pl',
      url: 'https://open.spotify.com/playlist/pl',
      createdAt: '2027-01-02T12:30:00.000Z',
    });
    const command = send.mock.calls[0]?.[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.Item).toMatchObject({ pk: 'PLAYLIST', date: '2027' });
    expect(command.input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('la escritura es condicional: la primera playlist registrada para el año vale', async () => {
    const { state } = setup(
      () => new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }),
    );
    await expect(
      state.savePlaylist({ year: 2027, playlistId: 'x', url: 'u', createdAt: 'c' }),
    ).resolves.toBe('already-exists');
  });

  it('otros errores de DynamoDB se propagan', async () => {
    const { state } = setup(() => new Error('throttled'));
    await expect(
      state.savePlaylist({ year: 2027, playlistId: 'x', url: 'u', createdAt: 'c' }),
    ).rejects.toThrow('throttled');
  });

  it('lee la playlist por año', async () => {
    const { state, send } = setup(() => ({
      Item: { pk: 'PLAYLIST', date: '2027', playlistId: 'pl', url: 'u', createdAt: 'c' },
    }));
    await expect(state.getPlaylist(2027)).resolves.toEqual({
      year: 2027,
      playlistId: 'pl',
      url: 'u',
      createdAt: 'c',
    });
    expect((send.mock.calls[0]?.[0] as GetCommand).input.Key).toEqual({
      pk: 'PLAYLIST',
      date: '2027',
    });
  });

  it('devuelve null si el año no tiene playlist', async () => {
    await expect(setup().state.getPlaylist(2030)).resolves.toBeNull();
  });

  it('las fechas sincronizadas viven en PLAYLIST#<año> y se registran por fecha (idempotente)', async () => {
    const { state, send } = setup((command) =>
      command instanceof QueryCommand
        ? { Items: [{ date: '2027-01-01', spotifyTrackId: 't', syncedAt: 's' }] }
        : {},
    );
    await state.markSynced(2027, [{ date: '2027-01-01', spotifyTrackId: 't', syncedAt: 's' }]);
    const put = send.mock.calls[0]?.[0] as PutCommand;
    expect(put.input.Item).toMatchObject({ pk: 'PLAYLIST#2027', date: '2027-01-01' });
    expect(put.input.ConditionExpression).toBeUndefined();

    await expect(state.listSynced(2027)).resolves.toEqual([
      { date: '2027-01-01', spotifyTrackId: 't', syncedAt: 's' },
    ]);
  });

  it('el candado es un Put condicional en su propia partición, con vencimiento', async () => {
    const { state, send } = setup();
    expect(await state.acquireLock(2027, 'yo', 1000, 300_000)).toBe(true);
    const command = send.mock.calls[0]?.[0] as PutCommand;
    expect(command.input.Item).toEqual({
      pk: 'PLAYLIST_LOCK',
      date: '2027',
      owner: 'yo',
      expiresAtMs: 301_000,
    });
    expect(command.input.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR expiresAtMs <= :now',
    );
    expect(command.input.ExpressionAttributeValues).toEqual({ ':now': 1000 });
  });

  it('con el candado vigente de otro, acquireLock devuelve false', async () => {
    const { state } = setup(
      () => new ConditionalCheckFailedException({ message: 'held', $metadata: {} }),
    );
    expect(await state.acquireLock(2027, 'yo', 1000, 300_000)).toBe(false);
  });

  it('liberar vence el candado solo si sigue siendo del dueño (sin DeleteItem)', async () => {
    const { state, send } = setup();
    await state.releaseLock(2027, 'yo');
    const command = send.mock.calls[0]?.[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.Item).toMatchObject({ pk: 'PLAYLIST_LOCK', expiresAtMs: 0 });
    expect(command.input.ExpressionAttributeValues).toEqual({ ':owner': 'yo' });
  });

  it('liberar un candado ya tomado por otro no falla', async () => {
    const { state } = setup(
      () => new ConditionalCheckFailedException({ message: 'other', $metadata: {} }),
    );
    await expect(state.releaseLock(2027, 'yo')).resolves.toBeUndefined();
  });

  it('otros errores al tomar el candado se propagan', async () => {
    const { state } = setup(() => new Error('throttled'));
    await expect(state.acquireLock(2027, 'yo', 1, 1)).rejects.toThrow('throttled');
  });
});
