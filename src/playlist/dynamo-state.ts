import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { PlaylistRecord, PlaylistStateRepository, SyncedEntry } from './state.ts';

/**
 * Misma tabla que las canciones, con otras particiones (`PLAYLIST` y `PLAYLIST#<año>`). Las
 * consultas de la API filtran por la partición `TRACK`, así que nada de esto es visible por HTTP.
 * La clave de ordenación se llama `date` por la tabla: aquí guarda el año o la fecha.
 */
export const PLAYLIST_PARTITION = 'PLAYLIST';
const syncedPartition = (year: number) => `PLAYLIST#${year}`;
/** Candados por año. Partición propia: no se mezcla con `PLAYLIST#<año>` ni con `TRACK`. */
export const PLAYLIST_LOCK_PARTITION = 'PLAYLIST_LOCK';

export class DynamoPlaylistState implements PlaylistStateRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(client: DynamoDBDocumentClient, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async getPlaylist(year: number): Promise<PlaylistRecord | null> {
    const { Item } = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: PLAYLIST_PARTITION, date: String(year) },
      }),
    );
    if (!Item) return null;
    return {
      year,
      playlistId: Item.playlistId as string,
      url: Item.url as string,
      createdAt: Item.createdAt as string,
    };
  }

  async savePlaylist(record: PlaylistRecord): Promise<'created' | 'already-exists'> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            pk: PLAYLIST_PARTITION,
            date: String(record.year),
            playlistId: record.playlistId,
            url: record.url,
            createdAt: record.createdAt,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'created';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return 'already-exists';
      throw error;
    }
  }

  async listSynced(year: number): Promise<SyncedEntry[]> {
    const { Items = [] } = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': syncedPartition(year) },
      }),
    );
    return Items.map((item) => ({
      date: item.date as string,
      spotifyTrackId: item.spotifyTrackId as string,
      syncedAt: item.syncedAt as string,
    }));
  }

  async markSynced(year: number, entries: readonly SyncedEntry[]): Promise<void> {
    await Promise.all(
      entries.map((entry) =>
        this.#client.send(
          new PutCommand({
            TableName: this.#tableName,
            Item: { pk: syncedPartition(year), ...entry },
          }),
        ),
      ),
    );
  }

  /** Put condicional: gana quien lo toma libre o vencido. Solo requiere dynamodb:PutItem. */
  async acquireLock(year: number, owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: {
            pk: PLAYLIST_LOCK_PARTITION,
            date: String(year),
            owner,
            expiresAtMs: nowMs + ttlMs,
          },
          ConditionExpression: 'attribute_not_exists(pk) OR expiresAtMs <= :now',
          ExpressionAttributeValues: { ':now': nowMs },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  /** Liberar es vencer el candado (otro Put condicional por dueño): no necesita DeleteItem. */
  async releaseLock(year: number, owner: string): Promise<void> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { pk: PLAYLIST_LOCK_PARTITION, date: String(year), owner, expiresAtMs: 0 },
          ConditionExpression: 'attribute_exists(pk) AND #owner = :owner',
          ExpressionAttributeNames: { '#owner': 'owner' },
          ExpressionAttributeValues: { ':owner': owner },
        }),
      );
    } catch (error) {
      // Ya vencido y tomado por otro: no hay nada que liberar.
      if (error instanceof ConditionalCheckFailedException) return;
      throw error;
    }
  }
}
