import { buildDevFixtures } from './dev-fixtures.ts';
import { InMemoryTrackRepository } from './in-memory-repository.ts';
import type { TrackRepository } from './repository.ts';

/**
 * Punto único de composición del repositorio. Placeholder hasta que exista la
 * implementación sobre DynamoDB (tabla en TRACKS_TABLE_NAME): sin fixtures
 * devuelve un repositorio vacío.
 */
export function createTrackRepository(env: NodeJS.ProcessEnv, now: Date): TrackRepository {
  const initial = env.USE_DEV_FIXTURES === 'true' ? buildDevFixtures(now) : [];
  return new InMemoryTrackRepository(initial);
}
