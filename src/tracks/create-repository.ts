import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDevFixtures } from './dev-fixtures.ts';
import { DynamoTrackRepository } from './dynamo-repository.ts';
import { InMemoryTrackRepository } from './in-memory-repository.ts';
import type { TrackRepository } from './repository.ts';

/**
 * Punto único de composición del repositorio.
 * - TRACKS_TABLE_NAME definida (despliegue): DynamoDB. Tiene prioridad para que unos fixtures
 *   olvidados en el entorno nunca se sirvan desde una tabla real.
 * - USE_DEV_FIXTURES=true (local): canciones ficticias en memoria.
 * - Sin ninguna: repositorio en memoria vacío.
 */
export function createTrackRepository(env: NodeJS.ProcessEnv, now: Date): TrackRepository {
  if (env.TRACKS_TABLE_NAME) {
    return new DynamoTrackRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      env.TRACKS_TABLE_NAME,
    );
  }
  const initial = env.USE_DEV_FIXTURES === 'true' ? buildDevFixtures(now) : [];
  return new InMemoryTrackRepository(initial);
}
