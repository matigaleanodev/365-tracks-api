import type { CriteriaWeights, EditorialCriterion } from '../music-selection/criteria.ts';
import { createOpenAiProposer } from '../music-selection/proposer.ts';
import {
  createEditorialSelector,
  SelectionFailedError,
  type SelectionEvaluationEvent,
} from '../music-selection/selector.ts';
import { addDays, type IsoDate } from '../shared/dates.ts';
import { HttpError, type HttpDependencies } from '../shared/resilient-fetch.ts';
import {
  createTimeBudget,
  SELECTION_SAFETY_MARGIN_MS,
  TimeBudgetExhaustedError,
} from '../shared/time-budget.ts';
import { createClientCredentialsProvider } from '../spotify/auth.ts';
import { createSpotifyClient } from '../spotify/client.ts';
import { generateDailyTrack } from '../tracks/generate-daily-track.ts';
import { InMemoryTrackRepository } from '../tracks/in-memory-repository.ts';
import type { DailyTrack } from '../tracks/types.ts';
import { createGuardedFetch } from './guarded-fetch.ts';
import type { PreviewCredentials, PreviewMode } from './preview-config.ts';

export interface RejectionRecord {
  criterion: EditorialCriterion;
  /** Título y artista propuestos por el modelo (nunca datos de Spotify). */
  title: string;
  artist: string;
  reason: string;
}

export interface SelectedSong {
  title: string;
  artist: string;
  album: string;
  releaseYear: number;
  spotifyTrackId: string;
  spotifyUrl: string;
  criterion: string;
  description: string;
  reasonId: string | undefined;
  traits: string[];
}

export type SampleStatus = 'selected' | 'no-selection' | 'error';

export interface SampleReport {
  date: IsoDate;
  status: SampleStatus;
  selected: SelectedSong | undefined;
  /** Criterios en el orden en que se probaron. */
  criteriaTried: EditorialCriterion[];
  rounds: number;
  invalidResponses: number;
  rejections: RejectionRecord[];
  error: { kind: string; message: string } | undefined;
  elapsedMs: number;
}

export interface PreviewRun {
  mode: PreviewMode;
  startDate: IsoDate;
  requested: number;
  catalogSize: number;
  samples: SampleReport[];
  /** Verdadero si se cortó antes de completar todas las muestras por un error. */
  aborted: boolean;
  network: {
    /** `simulated`: peticiones a un fetch simulado, sin red real. */
    mode: 'simulated' | 'live';
    requests: number;
    byHost: Record<string, number>;
    blocked: number;
  };
}

export interface PreviewRunOptions {
  mode: PreviewMode;
  startDate: IsoDate;
  count: number;
  catalog: readonly DailyTrack[];
  budgetMs: number;
  credentials: PreviewCredentials;
  weights: CriteriaWeights;
  /** Fetch real o simulado; el preview lo envuelve con la lista de destinos permitidos. */
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const MAX_MESSAGE_CHARS = 300;

/** Mensaje apto para stdout: sin secretos conocidos y acotado. */
export function sanitizeMessage(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret.length >= 4) safe = safe.split(secret).join('[redacted]');
  }
  return safe.replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_CHARS);
}

function describeError(
  error: unknown,
  secrets: readonly string[],
): { kind: string; message: string } {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const kind =
    error instanceof TimeBudgetExhaustedError
      ? 'time-budget-exhausted'
      : error instanceof HttpError
        ? error.kind
        : error instanceof Error
          ? error.name
          : 'error';
  return { kind, message: sanitizeMessage(message, secrets) };
}

/**
 * Recorre el camino real de selección (`generateDailyTrack` con el selector editorial, OpenAI y
 * Spotify) contra un repositorio en memoria sembrado con `catalog`. Nada se guarda ni se publica:
 * `create()` solo muta memoria y las fechas consecutivas se acumulan para que apliquen las
 * reglas de duplicados y de 60 días entre muestras.
 */
export async function runSelectionPreview(options: PreviewRunOptions): Promise<PreviewRun> {
  const { credentials, now = Date.now } = options;
  const secrets = [
    credentials.spotifyClientId,
    credentials.spotifyClientSecret,
    credentials.openAiApiKey,
  ];
  const guard = createGuardedFetch(options.fetch);
  const http: HttpDependencies = {
    fetch: guard.fetch,
    ...(options.sleep && { sleep: options.sleep }),
    ...(options.random && { random: options.random }),
  };

  const repository = new InMemoryTrackRepository(options.catalog);
  const spotify = createSpotifyClient({
    tokens: createClientCredentialsProvider({
      clientId: credentials.spotifyClientId,
      clientSecret: credentials.spotifyClientSecret,
      http,
      now,
    }),
    http,
  });

  let events: SelectionEvaluationEvent[] = [];
  const selector = createEditorialSelector({
    proposer: createOpenAiProposer({
      apiKey: credentials.openAiApiKey,
      model: credentials.openAiModel,
      http,
      includeTraits: true,
    }),
    spotify,
    repository,
    weights: options.weights,
    onEvaluation: (event) => events.push(event),
  });

  const samples: SampleReport[] = [];
  let aborted = false;

  for (let offset = 0; offset < options.count; offset += 1) {
    const date = addDays(options.startDate, offset);
    events = [];
    const startedAt = now();
    const budget = createTimeBudget({
      deadlineMs: startedAt + options.budgetMs,
      reserveMs: SELECTION_SAFETY_MARGIN_MS,
      now,
    });

    let selected: SelectedSong | undefined;
    let error: SampleReport['error'];
    let status: SampleStatus = 'selected';
    try {
      const result = await generateDailyTrack(
        { repository, selector, spotify, now: () => new Date(now()) },
        date,
        { budget },
      );
      if (result.status !== 'created') {
        status = 'error';
        error = { kind: 'already-exists', message: `The catalog already has a track for ${date}` };
      } else {
        const accepted = events.findLast((event) => event.type === 'accepted');
        selected = {
          title: result.track.title,
          artist: result.track.artist,
          album: result.track.album,
          releaseYear: result.track.releaseYear,
          spotifyTrackId: result.track.spotifyTrackId,
          spotifyUrl: result.track.spotifyUrl,
          criterion: result.track.selectionCriterion,
          description: result.track.description ?? '',
          reasonId: accepted?.type === 'accepted' ? accepted.proposal.reasonId : undefined,
          traits: accepted?.type === 'accepted' ? [...(accepted.proposal.traits ?? [])] : [],
        };
      }
    } catch (caught) {
      if (caught instanceof SelectionFailedError) {
        status = 'no-selection';
      } else {
        status = 'error';
        error = describeError(caught, secrets);
      }
    }

    samples.push({
      date,
      status,
      selected,
      criteriaTried: [
        ...new Set(
          events.flatMap((event) => (event.type === 'round-started' ? [event.criterion] : [])),
        ),
      ],
      rounds: events.filter((event) => event.type === 'round-started').length,
      invalidResponses: events.filter((event) => event.type === 'round-failed').length,
      rejections: events.flatMap((event) =>
        event.type === 'discarded'
          ? [
              {
                criterion: event.criterion,
                title: event.proposal.title,
                artist: event.proposal.artist,
                reason: event.reason,
              },
            ]
          : [],
      ),
      error,
      elapsedMs: Math.max(0, now() - startedAt),
    });

    if (status === 'error') {
      aborted = offset < options.count - 1;
      break;
    }
  }

  const byHost: Record<string, number> = {};
  for (const { host } of guard.requests) byHost[host] = (byHost[host] ?? 0) + 1;
  return {
    mode: options.mode,
    startDate: options.startDate,
    requested: options.count,
    catalogSize: options.catalog.length,
    samples,
    aborted,
    network: {
      mode: options.mode === 'live' ? 'live' : 'simulated',
      requests: guard.requests.length,
      byHost,
      blocked: guard.blocked.length,
    },
  };
}

/** 0 todas seleccionadas, 2 alguna sin selección válida, 1 error. */
export function exitCodeFor(run: PreviewRun): 0 | 1 | 2 {
  if (run.samples.some((sample) => sample.status === 'error')) return 1;
  if (run.samples.some((sample) => sample.status === 'no-selection')) return 2;
  return 0;
}
