import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { editTrackDescription } from '../../src/tracks/edit-description.ts';

const TABLE = 'tracks';
const OLD =
  'Una descripción editorial vigente, sin datos dudosos ni citas, de longitud suficiente.';
const NEW = 'Una descripción corregida, concreta y sin afirmaciones que no se puedan verificar.';

type Item = Record<string, unknown>;

/** Condiciones soportadas: attribute_exists/attribute_not_exists y `#nombre = :valor`, unidas por AND. */
function holds(item: Item | undefined, input: UpdateCommand['input']): boolean {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const attr = (token: string) => names[token] ?? token;
  return (input.ConditionExpression ?? '').split(' AND ').every((term) => {
    const exists = /^attribute_exists\((.+)\)$/.exec(term);
    if (exists) return item !== undefined && item[attr(exists[1] ?? '')] !== undefined;
    const absent = /^attribute_not_exists\((.+)\)$/.exec(term);
    if (absent) return item === undefined || item[attr(absent[1] ?? '')] === undefined;
    const [left, right] = term.split(' = ');
    return item !== undefined && item[attr(left ?? '')] === values[right ?? ''];
  });
}

function fake(
  options: { beforeUpdate?: (items: Map<string, Item>) => void; failUpdate?: Error } = {},
) {
  const items = new Map<string, Item>();
  const calls: string[] = [];
  const track: Item = {
    pk: 'TRACK',
    date: '2027-03-01',
    title: 'Song',
    artist: 'Band',
    album: 'Album',
    releaseYear: 1990,
    spotifyTrackId: 'abc123',
    spotifyUrl: 'https://open.spotify.com/track/abc123',
    selectionCriterion: 'manual',
    description: OLD,
    createdAt: '2026-11-21T13:00:00.000Z',
    spotifyArtistId: 'art1',
  };
  items.set('TRACK|2027-03-01', track);
  items.set('CLAIM|id#abc123', { pk: 'CLAIM', date: 'id#abc123', trackDate: '2027-03-01' });
  items.set('ARTIST|name#band', {
    pk: 'ARTIST',
    date: 'name#band',
    dates: ['2027-03-01'],
    version: 1,
  });
  const key = (k: Item) => `${String(k.pk)}|${String(k.date)}`;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) {
        calls.push('get');
        const found = items.get(key(command.input.Key ?? {}));
        return { Item: found && structuredClone(found) };
      }
      if (command instanceof UpdateCommand) {
        calls.push('update');
        // Como lib-dynamodb: un valor undefined se rechaza.
        for (const value of Object.values(command.input.ExpressionAttributeValues ?? {})) {
          if (value === undefined) throw new Error('undefined value');
        }
        options.beforeUpdate?.(items);
        if (options.failUpdate) throw options.failUpdate;
        const k = key(command.input.Key ?? {});
        const current = items.get(k);
        if (!holds(current, command.input)) {
          throw new ConditionalCheckFailedException({ message: 'condition', $metadata: {} });
        }
        expect(command.input.UpdateExpression).toBe('SET #description = :new');
        if (current) current.description = command.input.ExpressionAttributeValues?.[':new'];
        return {};
      }
      throw new Error('operación no soportada');
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, items, calls };
}

const snapshot = (items: Map<string, Item>) => structuredClone([...items.entries()]);

describe('editTrackDescription', () => {
  it('una descripción inválida no toca la tabla', async () => {
    const { client, items, calls } = fake();
    const before = JSON.stringify([...items.entries()]);
    const result = await editTrackDescription(client, TABLE, {
      date: '2027-03-01',
      newDescription: 'corta',
    });
    expect(result.status).toBe('invalid');
    expect(calls).toEqual([]);
    expect(JSON.stringify([...items.entries()])).toBe(before);
  });

  it('actualiza solo la descripción: resto del TRACK, CLAIM y ARTIST idénticos', async () => {
    const { client, items } = fake();
    const before = snapshot(items);
    const result = await editTrackDescription(client, TABLE, {
      date: '2027-03-01',
      expectedDescription: OLD,
      newDescription: NEW,
    });
    expect(result).toEqual({ status: 'updated', previous: OLD });
    const expected = structuredClone(before);
    (expected[0]?.[1] as Item).description = NEW;
    expect(snapshot(items)).toEqual(expected);
  });

  it('rechaza si la descripción esperada no coincide con la publicada', async () => {
    const { client, items, calls } = fake();
    const before = snapshot(items);
    const result = await editTrackDescription(client, TABLE, {
      date: '2027-03-01',
      expectedDescription: 'Otra descripción distinta de la publicada, también bastante larga.',
      newDescription: NEW,
    });
    expect(result.status).toBe('conflict');
    expect(calls).toEqual(['get']);
    expect(snapshot(items)).toEqual(before);
  });

  it('detecta una edición concurrente entre la lectura y la escritura y la conserva', async () => {
    const other = 'Edición concurrente de otro operador, que no debe perderse ni pisarse.';
    const { client, items } = fake({
      beforeUpdate: (map) => {
        (map.get('TRACK|2027-03-01') as Item).description = other;
      },
    });
    const result = await editTrackDescription(client, TABLE, {
      date: '2027-03-01',
      newDescription: NEW,
    });
    expect(result.status).toBe('conflict');
    expect((items.get('TRACK|2027-03-01') as Item).description).toBe(other);
  });

  it('un fallo de red en la escritura se propaga y deja la publicación previa intacta', async () => {
    const { client, items } = fake({ failUpdate: new Error('network down') });
    const before = snapshot(items);
    await expect(
      editTrackDescription(client, TABLE, { date: '2027-03-01', newDescription: NEW }),
    ).rejects.toThrow('network down');
    expect(snapshot(items)).toEqual(before);
  });

  it('sin createdAt no envía undefined y exige que siga ausente', async () => {
    const { client, items } = fake();
    delete (items.get('TRACK|2027-03-01') as Item).createdAt;
    const result = await editTrackDescription(client, TABLE, {
      date: '2027-03-01',
      newDescription: NEW,
    });
    expect(result.status).toBe('updated');
    expect((items.get('TRACK|2027-03-01') as Item).description).toBe(NEW);
  });

  it('informa not-found y unchanged sin escribir', async () => {
    const { client, calls } = fake();
    expect(
      (await editTrackDescription(client, TABLE, { date: '2030-01-01', newDescription: NEW }))
        .status,
    ).toBe('not-found');
    expect(
      (await editTrackDescription(client, TABLE, { date: '2027-03-01', newDescription: OLD }))
        .status,
    ).toBe('unchanged');
    expect(calls).not.toContain('update');
  });
});
