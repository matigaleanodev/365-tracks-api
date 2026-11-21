import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { IsoDate } from '../shared/dates.ts';
import type {
  CreateTrackResult,
  ListTracksOptions,
  TrackPage,
  TrackRepository,
} from './repository.ts';
import type { DailyTrack } from './types.ts';

/** Partición única: ~365 ítems por año caben de sobra y permiten un Query ordenado por fecha. */
export const TRACKS_PARTITION = 'TRACK';

type TrackItem = DailyTrack & { pk: string };

function toTrack({ pk: _pk, ...track }: TrackItem): DailyTrack {
  return track;
}

export class DynamoTrackRepository implements TrackRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;

  constructor(client: DynamoDBDocumentClient, tableName: string) {
    this.#client = client;
    this.#tableName = tableName;
  }

  async getByDate(date: IsoDate): Promise<DailyTrack | null> {
    const { Item } = await this.#client.send(
      new GetCommand({ TableName: this.#tableName, Key: { pk: TRACKS_PARTITION, date } }),
    );
    return Item ? toTrack(Item as TrackItem) : null;
  }

  async list({ limit, before }: ListTracksOptions): Promise<TrackPage> {
    // Sin filtros, Limit cuenta ítems devueltos: pedir uno de más indica si hay otra página.
    const { Items = [] } = await this.#client.send(
      new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: before ? 'pk = :pk AND #date < :before' : 'pk = :pk',
        ExpressionAttributeNames: before ? { '#date': 'date' } : undefined,
        ExpressionAttributeValues: {
          ':pk': TRACKS_PARTITION,
          ...(before ? { ':before': before } : {}),
        },
        ScanIndexForward: false,
        Limit: limit + 1,
      }),
    );
    return {
      items: Items.slice(0, limit).map((item) => toTrack(item as TrackItem)),
      hasMore: Items.length > limit,
    };
  }

  async create(track: DailyTrack): Promise<CreateTrackResult> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#tableName,
          Item: { pk: TRACKS_PARTITION, ...track },
          // La condición se evalúa sobre el ítem con la misma clave (pk + date).
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return 'created';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return 'already-exists';
      }
      throw error;
    }
  }
}
