import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { vi } from 'vitest';
import { DynamoTrackRepository } from '../../src/tracks/dynamo-repository.ts';

/**
 * DynamoDB falso con transacciones atómicas: evalúa todas las condiciones y aplica todo o nada.
 * Las lecturas ceden el turno, así dos escrituras concurrentes leen el mismo estado antes de que
 * cualquiera escriba: es la carrera real que la transacción tiene que resolver.
 */
export function fakeDynamo({ pageSize }: { pageSize?: number } = {}) {
  /** Entradas de cada Query, para comprobar p. ej. `ConsistentRead`. */
  const queries: Record<string, unknown>[] = [];
  const items = new Map<string, Record<string, unknown>>();
  const keyOf = (item: Record<string, unknown>) => `${String(item.pk)}|${String(item.date)}`;
  const transactions = vi.fn();
  const client = {
    async send(command: unknown) {
      if (command instanceof GetCommand) {
        await Promise.resolve();
        await Promise.resolve();
        const { pk, date } = command.input.Key as { pk: string; date: string };
        const item = items.get(`${pk}|${date}`);
        return item ? { Item: structuredClone(item) } : {};
      }
      if (command instanceof TransactWriteCommand) {
        transactions();
        const entries = command.input.TransactItems ?? [];
        const reasons = entries.map((entry) => {
          const put = entry.Put;
          const del = entry.Delete;
          const values = (put ?? del)?.ExpressionAttributeValues as
            Record<string, unknown> | undefined;
          const condition = (put ?? del)?.ConditionExpression ?? '';
          const current = items.get(
            put
              ? keyOf(put.Item as Record<string, unknown>)
              : keyOf(del!.Key as Record<string, unknown>),
          );
          let ok: boolean;
          if (condition.includes('attribute_not_exists')) ok = current === undefined;
          else if (condition.includes('#version')) ok = current?.version === values?.[':version'];
          else if (condition.includes('spotifyTrackId'))
            ok = current?.spotifyTrackId === values?.[':id'];
          else if (condition.includes('trackDate'))
            ok = current?.trackDate === (values?.[':heldBy'] ?? values?.[':date']);
          else ok = true;
          return { Code: ok ? 'None' : 'ConditionalCheckFailed' };
        });
        if (reasons.some((reason) => reason.Code !== 'None')) {
          throw new TransactionCanceledException({
            message: 'canceled',
            $metadata: {},
            CancellationReasons: reasons,
          });
        }
        for (const entry of entries) {
          if (entry.Put) {
            const item = entry.Put.Item as Record<string, unknown>;
            items.set(keyOf(item), structuredClone(item));
          } else if (entry.Delete) {
            items.delete(keyOf(entry.Delete.Key as Record<string, unknown>));
          }
        }
        return {};
      }
      if (command instanceof QueryCommand) {
        const input = command.input;
        queries.push(structuredClone(input) as Record<string, unknown>);
        const values = (input.ExpressionAttributeValues ?? {}) as Record<string, string>;
        const pk = values[':pk'] ?? 'TRACK';
        const ascending = input.ScanIndexForward !== false;
        const sorted = [...items.values()]
          .filter((item) => item.pk === pk)
          .filter((item) => !values[':before'] || String(item.date) < values[':before'])
          .sort((a, b) => String(a.date).localeCompare(String(b.date)) * (ascending ? 1 : -1));
        const start = input.ExclusiveStartKey as { date: string } | undefined;
        const from = start ? sorted.findIndex((item) => item.date === start.date) + 1 : 0;
        const size = Math.min(input.Limit ?? Infinity, pageSize ?? Infinity);
        const page = sorted.slice(from, from + size);
        const last = page.at(-1);
        return {
          Items: page.map((item) => structuredClone(item)),
          ...(last && from + size < sorted.length && { LastEvaluatedKey: { pk, date: last.date } }),
        };
      }
      throw new Error('unexpected command');
    },
  };
  const documentClient = client as unknown as DynamoDBDocumentClient;
  const repository = new DynamoTrackRepository(documentClient, 't');
  const tracks = () => [...items.values()].filter((item) => item.pk === 'TRACK');
  return { repository, items, tracks, transactions, queries, client: documentClient, table: 't' };
}
