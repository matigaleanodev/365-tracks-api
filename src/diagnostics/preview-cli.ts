import { parseCriteriaWeights, type CriteriaWeights } from '../music-selection/criteria.ts';
import type { DailyTrack } from '../tracks/types.ts';
import { addDays } from '../shared/dates.ts';
import { loadCatalogFile } from './catalog-file.ts';
import {
  parsePreviewArgs,
  readCredentials,
  USAGE,
  type PreviewCredentials,
} from './preview-config.ts';
import { formatJson, formatText } from './report.ts';
import { exitCodeFor, runSelectionPreview, sanitizeMessage } from './selection-preview.ts';
import {
  createSimulatedWorld,
  DEFAULT_SIMULATED_SONGS,
  defaultOpenAiScenario,
} from './simulated-world.ts';

export interface PreviewCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Solo para tests con `--live`: por defecto se usa el fetch global. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loadCatalog?: (path: string) => Promise<DailyTrack[]>;
}

const NO_MODE_MESSAGE = `No network mode selected, so nothing was called.
Use --simulate to see the report format with deterministic fake responses (no network, no credentials),
or --live to call OpenAI and Spotify for real (needs SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
OPENAI_API_KEY and OPENAI_MODEL in the environment, and explicit authorization).
`;

const SIMULATED_CREDENTIALS: PreviewCredentials = {
  spotifyClientId: 'simulated-client-id',
  spotifyClientSecret: 'simulated-client-secret',
  openAiApiKey: 'simulated-openai-key',
  openAiModel: 'simulated-model',
};

/**
 * CLI del preview. Devuelve el código de salida (0 seleccionada, 2 sin selección válida, 1 error)
 * y escribe el informe solo en stdout. Sin `--live` ni `--simulate` no hace ninguna llamada de red.
 */
export async function runPreviewCli(
  argv: readonly string[],
  deps: PreviewCliDeps,
): Promise<number> {
  const parsed = parsePreviewArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const { options } = parsed;
  if (options.help) {
    deps.stdout(USAGE);
    return 0;
  }
  if (options.mode === undefined) {
    deps.stderr(`${NO_MODE_MESSAGE}\n${USAGE}`);
    return 1;
  }

  let weights: CriteriaWeights;
  try {
    weights = parseCriteriaWeights(deps.env.CRITERIA_WEIGHTS);
  } catch (error) {
    deps.stderr(
      `CRITERIA_WEIGHTS is invalid: ${error instanceof Error ? error.message : 'error'}\n`,
    );
    return 1;
  }

  // Antes de cualquier llamada: sin las cuatro variables no se sale a la red.
  let credentials = SIMULATED_CREDENTIALS;
  if (options.mode === 'live') {
    const read = readCredentials(deps.env);
    if (!read.ok) {
      deps.stderr(`--live requires these environment variables: ${read.missing.join(', ')}\n`);
      return 1;
    }
    credentials = read.credentials;
  }

  let catalog: DailyTrack[] = [];
  try {
    if (options.catalogPath !== undefined) {
      catalog = await (deps.loadCatalog ?? loadCatalogFile)(options.catalogPath);
    }
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : 'Catalog could not be loaded'}\n`);
    return 1;
  }
  const taken = new Set(catalog.map((track) => track.date));
  for (let offset = 0; offset < options.count; offset += 1) {
    const date = addDays(options.date, offset);
    if (taken.has(date)) {
      deps.stderr(`The local catalog already has a track for ${date}; choose another date.\n`);
      return 1;
    }
  }

  const simulated =
    options.mode === 'simulate'
      ? createSimulatedWorld({
          songs: DEFAULT_SIMULATED_SONGS,
          openAi: defaultOpenAiScenario(),
        })
      : undefined;

  try {
    const run = await runSelectionPreview({
      mode: options.mode,
      startDate: options.date,
      count: options.count,
      catalog,
      budgetMs: options.budgetMs,
      credentials,
      weights,
      fetch: simulated?.fetch ?? deps.fetch ?? globalThis.fetch,
      ...(simulated ? { sleep: () => Promise.resolve() } : deps.sleep && { sleep: deps.sleep }),
      ...(deps.now && { now: deps.now }),
    });
    deps.stdout(options.json ? formatJson(run) : formatText(run));
    return exitCodeFor(run);
  } catch (error) {
    const secrets = [
      credentials.spotifyClientId,
      credentials.spotifyClientSecret,
      credentials.openAiApiKey,
    ];
    deps.stderr(
      `Preview failed: ${sanitizeMessage(error instanceof Error ? error.message : 'Unknown error', secrets)}\n`,
    );
    return 1;
  }
}
