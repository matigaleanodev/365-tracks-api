import { createHash } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_ARTIST_COOLDOWN_DAYS } from '../music-selection/rules.ts';
import { recordingKeyOf } from '../music-selection/recording-key.ts';
import type { IsoDate } from '../shared/dates.ts';
import { artistControlKeys } from './artist-key.ts';
import type {
  CreateTrackResult,
  ListTracksOptions,
  TrackPage,
  TrackRepository,
} from './repository.ts';
import type { DailyTrack } from './types.ts';

/** Partición única: ~365 ítems por año caben de sobra y permiten un Query ordenado por fecha. */
export const TRACKS_PARTITION = 'TRACK';

/**
 * Registros de control en la misma tabla, solo accesibles con las operaciones que ya tiene el rol
 * (GetItem, PutItem y TransactWriteItems sobre esos mismos Put). La API consulta solo `TRACK`.
 * - `CLAIM`: una reserva por ID de Spotify y otra por grabación (título base + artista). Su
 *   condición `attribute_not_exists` impide dos fechas con la misma canción, aunque ocurran a la vez.
 * - `ARTIST`: por artista (nombre normalizado y, si existe, ID de Spotify) la lista de fechas y una
 *   versión. Cada escritura incrementa la versión con condición: de dos escrituras concurrentes
 *   sobre el mismo artista solo una prospera y la otra vuelve a evaluar el intervalo de 60 días.
 */
export const CLAIMS_PARTITION = 'CLAIM';
export const ARTISTS_PARTITION = 'ARTIST';
const MAX_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
/** Pausa creciente ante contención o throttling transitorios. */
const BACKOFF_MS = 25;
const TRANSIENT_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
  'RequestLimitExceeded',
]);

/** Claves de control. La de grabación se resume con un hash: título y artista no acotan la clave. */
export const idClaimKey = (spotifyTrackId: string) => `id#${spotifyTrackId}`;
export const recordingClaimKey = (title: string, artist: string) =>
  `rec#${createHash('sha256').update(recordingKeyOf(title, artist)).digest('hex')}`;
/** Se reexporta desde artist-key.ts para no romper a quienes ya la importan de aquí. */
export { artistControlKeys };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const daysBetween = (a: IsoDate, b: IsoDate) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

interface ArtistItem {
  dates: IsoDate[];
  version: number;
}

type TrackItem = DailyTrack & { pk: string };

function toTrack({ pk: _pk, ...track }: TrackItem): DailyTrack {
  return track;
}

export class DynamoTrackRepository implements TrackRepository {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #cooldownDays: number;

  constructor(
    client: DynamoDBDocumentClient,
    tableName: string,
    cooldownDays: number = DEFAULT_ARTIST_COOLDOWN_DAYS,
  ) {
    this.#client = client;
    this.#tableName = tableName;
    this.#cooldownDays = cooldownDays;
  }

  async getByDate(date: IsoDate): Promise<DailyTrack | null> {
    const { Item } = await this.#client.send(
      // Consistente: tras una cancelación `already-exists` hay que ver la fila ganadora.
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: TRACKS_PARTITION, date },
        ConsistentRead: true,
      }),
    );
    return Item ? toTrack(Item as TrackItem) : null;
  }

  async list({ limit, before }: ListTracksOptions): Promise<TrackPage> {
    // Sin filtros, Limit cuenta ítems devueltos: pedir uno de más indica si hay otra página. Un
    // Query también se corta a 1 MB: si quedan resultados (LastEvaluatedKey) se sigue leyendo.
    const items: TrackItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const { Items = [], LastEvaluatedKey } = await this.#client.send(
        new QueryCommand({
          TableName: this.#tableName,
          KeyConditionExpression: before ? 'pk = :pk AND #date < :before' : 'pk = :pk',
          ExpressionAttributeNames: before ? { '#date': 'date' } : undefined,
          ExpressionAttributeValues: {
            ':pk': TRACKS_PARTITION,
            ...(before ? { ':before': before } : {}),
          },
          ScanIndexForward: false,
          Limit: limit + 1 - items.length,
          ...(startKey && { ExclusiveStartKey: startKey }),
        }),
      );
      items.push(...(Items as TrackItem[]));
      startKey = LastEvaluatedKey;
    } while (startKey && items.length < limit + 1);
    return {
      items: items.slice(0, limit).map(toTrack),
      hasMore: items.length > limit,
    };
  }

  async #readArtist(key: string): Promise<(ArtistItem & { exists: true }) | null> {
    const { Item } = await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { pk: ARTISTS_PARTITION, date: key },
        ConsistentRead: true,
      }),
    );
    return Item
      ? { exists: true, dates: Item.dates as IsoDate[], version: Item.version as number }
      : null;
  }

  async create(track: DailyTrack): Promise<CreateTrackResult> {
    const artistKeys = [...artistControlKeys(track)];

    // La fecha ocupada tiene precedencia sobre cualquier otra regla (igual que en memoria).
    if (await this.getByDate(track.date)) return 'already-exists';

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const artists = await Promise.all(artistKeys.map((key) => this.#readArtist(key)));
      // Fechas ocupadas por el artista, sin contar la propia: un reintento de la misma canción
      // debe terminar en `already-exists`, no en un falso conflicto.
      const tooClose = artists.some((artist) =>
        artist?.dates.some(
          (date) => date !== track.date && daysBetween(date, track.date) < this.#cooldownDays,
        ),
      );
      if (tooClose) return 'artist-cooldown';

      const claim = (key: string) => ({
        Put: {
          TableName: this.#tableName,
          Item: { pk: CLAIMS_PARTITION, date: key, trackDate: track.date },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
      try {
        await this.#client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.#tableName,
                  Item: { pk: TRACKS_PARTITION, ...track },
                  // La condición se evalúa sobre el ítem con la misma clave (pk + date).
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              claim(idClaimKey(track.spotifyTrackId)),
              claim(recordingClaimKey(track.title, track.artist)),
              ...artistKeys.map((key, index) => {
                const current = artists[index];
                return {
                  Put: {
                    TableName: this.#tableName,
                    Item: {
                      pk: ARTISTS_PARTITION,
                      date: key,
                      dates: [...(current?.dates ?? []), track.date],
                      version: (current?.version ?? 0) + 1,
                    },
                    ConditionExpression: current
                      ? '#version = :version'
                      : 'attribute_not_exists(pk)',
                    ...(current && {
                      ExpressionAttributeNames: { '#version': 'version' },
                      ExpressionAttributeValues: { ':version': current.version },
                    }),
                  },
                };
              }),
            ],
          }),
        );
        return 'created';
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        const codes = (error.CancellationReasons ?? []).map((reason) => reason.Code ?? 'None');
        const failed = (index: number) => codes[index] === 'ConditionalCheckFailed';
        if (failed(0)) return 'already-exists';
        if (failed(1)) return 'duplicate-track';
        if (failed(2)) return 'duplicate-recording';
        // Lo que queda: otra escritura tocó al mismo artista (se relee y se reevalúa), contención
        // o throttling (se reintenta con pausa) o un error permanente (se propaga con su causa).
        const permanent = codes.find(
          (code) =>
            code !== 'None' && code !== 'ConditionalCheckFailed' && !TRANSIENT_CODES.has(code),
        );
        if (permanent) {
          throw new Error(`Track for ${track.date} could not be stored: ${permanent}`, {
            cause: error,
          });
        }
        lastError = error;
        if (codes.some((code) => TRANSIENT_CODES.has(code)))
          await sleep(BACKOFF_MS * (attempt + 1));
      }
    }
    throw new Error(`Track for ${track.date} could not be stored: too much contention`, {
      cause: lastError,
    });
  }
}
