import { DEFAULT_CRITERIA_WEIGHTS } from '../../src/music-selection/criteria.ts';
import type { PreviewCredentials } from '../../src/diagnostics/preview-config.ts';
import {
  runSelectionPreview,
  type PreviewRun,
  type PreviewRunOptions,
} from '../../src/diagnostics/selection-preview.ts';
import {
  createSimulatedWorld,
  type OpenAiCall,
  type OpenAiStep,
  type SimCandidate,
  type SimulatedWorld,
  type SimulatedWorldOptions,
  type SimSong,
} from '../../src/diagnostics/simulated-world.ts';

export const TEST_CREDENTIALS: PreviewCredentials = {
  spotifyClientId: 'test-spotify-client-id',
  spotifyClientSecret: 'test-spotify-client-secret',
  openAiApiKey: 'test-openai-api-key',
  openAiModel: 'test-model',
};

export const song = (n: number, overrides: Partial<SimSong> = {}): SimSong => ({
  title: `Test Song ${n}`,
  artist: `Test Artist ${n}`,
  album: `Test Album ${n}`,
  releaseYear: 1980 + n,
  ...overrides,
});

export const candidateOf = (s: SimSong, overrides: Partial<SimCandidate> = {}): SimCandidate => ({
  title: s.title,
  artist: s.artist,
  releaseYear: s.releaseYear,
  ...overrides,
});

/** Guion: la llamada i recibe `steps[i]`; agotado, una respuesta sin candidatos válidos. */
export const scripted =
  (steps: OpenAiStep[]) =>
  ({ index }: OpenAiCall): OpenAiStep =>
    steps[index] ?? { candidates: [] };

export const world = (
  songs: readonly SimSong[],
  openAi: SimulatedWorldOptions['openAi'],
  spotifyIntercept?: SimulatedWorldOptions['spotifyIntercept'],
): SimulatedWorld =>
  createSimulatedWorld({ songs, openAi, ...(spotifyIntercept && { spotifyIntercept }) });

/** Ejecuta el preview contra un mundo simulado, sin dormir de verdad. */
export function preview(
  simulated: SimulatedWorld,
  overrides: Partial<PreviewRunOptions> = {},
): Promise<PreviewRun> {
  return runSelectionPreview({
    mode: 'simulate',
    startDate: '2027-01-01',
    count: 1,
    catalog: [],
    budgetMs: 180_000,
    credentials: TEST_CREDENTIALS,
    weights: DEFAULT_CRITERIA_WEIGHTS,
    fetch: simulated.fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}
