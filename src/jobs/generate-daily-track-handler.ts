import { getEditorialDate } from '../shared/dates.ts';
import { notImplementedMusicSelector } from '../music-selection/index.ts';
import { notImplementedSpotifyClient } from '../spotify/index.ts';
import { createTrackRepository } from '../tracks/create-repository.ts';
import {
  generateDailyTrack,
  type GenerateDailyTrackDependencies,
  type GenerateDailyTrackResult,
} from '../tracks/generate-daily-track.ts';

export interface DailyJobOutput {
  date: string;
  status: GenerateDailyTrackResult['status'];
}

export function createGenerateDailyTrackHandler(dependencies: GenerateDailyTrackDependencies) {
  return async (): Promise<DailyJobOutput> => {
    const date = getEditorialDate(dependencies.now());
    const { status } = await generateDailyTrack(dependencies, date);
    console.info(JSON.stringify({ event: 'daily-track', date, status }));
    return { date, status };
  };
}

export const handler = createGenerateDailyTrackHandler({
  repository: createTrackRepository(process.env, new Date()),
  selector: notImplementedMusicSelector,
  spotify: notImplementedSpotifyClient,
  now: () => new Date(),
});
