import { afterAll } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_ARTIST_COOLDOWN_DAYS } from '../../src/music-selection/rules.ts';
import type { IsoDate } from '../../src/shared/dates.ts';
import {
  CLAIMS_PARTITION,
  TRACKS_PARTITION,
  idClaimKey,
  recordingClaimKey,
} from '../../src/tracks/dynamo-repository.ts';
import type { DailyTrack } from '../../src/tracks/types.ts';
import { createDocClient, createTestTable, deleteTestTable } from './aws.ts';

export const COOLDOWN = DEFAULT_ARTIST_COOLDOWN_DAYS;
export const BASE_DATE = '2027-01-01' as IsoDate;

export const addDays = (date: string, days: number): IsoDate =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as IsoDate;

export const DESCRIPTION =
  'Una canción de guitarras luminosas y base rítmica directa, pensada para arrancar el día.';

/** ID de Spotify con formato válido (22 caracteres). */
export const spotifyId = (n: number) => `track${String(n).padStart(17, '0')}`;

/** Canción válida; por defecto cada `n` tiene su propio título, artista e ID. */
export function track(date: string, n: number, overrides: Partial<DailyTrack> = {}): DailyTrack {
  const id = spotifyId(n);
  return {
    date: date as IsoDate,
    title: `Title ${n}`,
    artist: `Artist ${n}`,
    album: 'Album',
    releaseYear: 1990,
    spotifyTrackId: id,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    selectionCriterion: 'manual',
    description: DESCRIPTION,
    createdAt: '2026-11-21T13:00:00.000Z',
    ...overrides,
  };
}

/**
 * Devuelve una función que crea una tabla temporal única (con su propio cliente) por test; todas
 * se borran al terminar el archivo.
 */
export function useTables() {
  const tables: { client: DynamoDBDocumentClient; tableName: string }[] = [];
  afterAll(async () => {
    for (const { client, tableName } of tables) {
      await deleteTestTable(client, tableName);
      client.destroy();
    }
  });
  return async () => {
    const client = createDocClient();
    const tableName = await createTestTable(client);
    tables.push({ client, tableName });
    return { client, tableName };
  };
}

/**
 * Catálogo anterior a las reservas: escribe solo el ítem TRACK (como las cargas viejas), sin
 * CLAIM ni ARTIST.
 */
export async function putLegacyTrack(
  client: DynamoDBDocumentClient,
  tableName: string,
  value: DailyTrack,
): Promise<void> {
  await client.send(
    new PutCommand({ TableName: tableName, Item: { pk: TRACKS_PARTITION, ...value } }),
  );
}

/** Reserva escrita a mano (p. ej. huérfana o con titular incorrecto). */
export async function putClaim(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: string,
  trackDate: string,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: { pk: CLAIMS_PARTITION, date: key, trackDate },
    }),
  );
}

export const claimKeysOf = (value: DailyTrack) => ({
  id: idClaimKey(value.spotifyTrackId),
  recording: recordingClaimKey(value.title, value.artist),
});
