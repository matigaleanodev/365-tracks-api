import { createTrackRepository } from '../tracks/create-repository.ts';
import { createApiHandler } from './app.ts';

export const handler = createApiHandler({
  repository: createTrackRepository(process.env, new Date()),
  now: () => new Date(),
});
