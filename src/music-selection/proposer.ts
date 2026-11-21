import type { IsoDate } from '../shared/dates.ts';
import { requestJson, type HttpDependencies, type HttpPolicy } from '../shared/resilient-fetch.ts';
import { CRITERION_BRIEF, type EditorialCriterion } from './criteria.ts';
import type { DiversityTargets } from './diversity.ts';

export interface SongProposal {
  title: string;
  artist: string;
  /** Año de lanzamiento original según el modelo; se contrasta con el catálogo real. */
  releaseYear: number;
  /** Fecha completa afirmada por el modelo; solo para efemérides, se verifica contra Spotify. */
  releaseDate: string | null;
  /** Explicación breve, escrita sin ningún dato de Spotify. */
  description: string;
}

/** Propuesta del propio modelo descartada en esta ejecución; nunca proviene de Spotify. */
export interface RejectedProposal {
  title: string;
  artist: string;
}

export interface ProposalRequest {
  date: IsoDate;
  criterion: EditorialCriterion;
  targets: DiversityTargets;
  count: number;
  rejected: readonly RejectedProposal[];
}

export interface SongProposer {
  propose(request: ProposalRequest): Promise<SongProposal[]>;
}

/** La respuesta del modelo no sirve (rechazo, truncada, JSON o forma inválidos). Se reintenta. */
export class ProposalResponseError extends Error {
  constructor(reason: string) {
    super(`OpenAI proposal response is not usable: ${reason}`);
    this.name = 'ProposalResponseError';
  }
}

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const OPENAI_HTTP_POLICY: HttpPolicy = {
  timeoutMs: 45_000,
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 15_000,
};

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'artist', 'releaseYear', 'releaseDate', 'description'],
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          releaseYear: { type: 'integer' },
          releaseDate: { type: ['string', 'null'] },
          description: { type: 'string' },
        },
      },
    },
  },
} as const;

export function buildInstructions(language: string): string {
  return [
    'You are the music editor of "365 Tracks", a public site that publishes one song per day, the same for everyone.',
    'You propose candidate songs from your own musical knowledge. You have no access to any streaming service or catalog data, and none is provided: never refer to one.',
    'Rules:',
    '- Propose real, officially released songs by their original artist and original studio recording. No covers, live versions, remixes, medleys or karaoke.',
    '- Never invent songs, artists, release years or dates. If you are unsure a song exists or who performs it, leave it out.',
    '- Follow the editorial criterion. The soft targets (decade, region, genre) guide variety; when they conflict with the criterion, the criterion wins.',
    '- Do not favour the most popular songs by default. Mix well-known songs and less obvious discoveries as the criterion asks.',
    '- Propose different artists across candidates, and do not repeat any song listed in "alreadyConsidered".',
    `- Write each description in ${language}: one paragraph of one or two sentences explaining why this song was chosen, specific to the song.`,
    "- A description must not contain quotations, lyrics, anecdotes, rankings, superlatives, promotional language, links, or the name of any month. Do not state a year unless it is the song's original release year and you are certain.",
    '- releaseDate is the exact original release date (YYYY-MM-DD) and is required only for the "music-anniversary" criterion; otherwise it must be null.',
  ].join('\n');
}

export function buildRequestInput(request: ProposalRequest): string {
  return JSON.stringify({
    date: request.date,
    criterion: request.criterion,
    criterionBrief: CRITERION_BRIEF[request.criterion],
    softTargets: request.targets,
    candidateCount: request.count,
    alreadyConsidered: request.rejected.map(({ title, artist }) => ({ title, artist })),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Texto de salida de una respuesta de la Responses API; detecta rechazos y respuestas truncadas. */
export function extractOutputText(json: unknown): string {
  if (!isRecord(json)) throw new ProposalResponseError('not an object');
  if (json.status !== undefined && json.status !== 'completed') {
    throw new ProposalResponseError(`status ${String(json.status)}`);
  }
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = isRecord(item) && Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === 'refusal') throw new ProposalResponseError('the model refused');
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  if (typeof json.output_text === 'string') return json.output_text;
  throw new ProposalResponseError('no output text');
}

/** Valida la forma de los candidatos. Descarta los inválidos; falla si no queda ninguno. */
export function parseProposals(text: string): SongProposal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProposalResponseError('invalid JSON');
  }
  const candidates = isRecord(parsed) ? parsed.candidates : undefined;
  if (!Array.isArray(candidates)) throw new ProposalResponseError('missing candidates');

  const proposals = candidates.flatMap((candidate): SongProposal[] => {
    if (!isRecord(candidate)) return [];
    const { title, artist, releaseYear, releaseDate, description } = candidate;
    const validDate =
      releaseDate === null ||
      (typeof releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate));
    if (
      typeof title !== 'string' ||
      title.trim() === '' ||
      typeof artist !== 'string' ||
      artist.trim() === '' ||
      typeof releaseYear !== 'number' ||
      !Number.isInteger(releaseYear) ||
      !validDate ||
      typeof description !== 'string'
    ) {
      return [];
    }
    return [
      {
        title: title.trim(),
        artist: artist.trim(),
        releaseYear,
        releaseDate: releaseDate as string | null,
        description: description.trim(),
      },
    ];
  });
  if (proposals.length === 0) throw new ProposalResponseError('no valid candidates');
  return proposals;
}

export interface OpenAiProposerOptions {
  apiKey: string;
  /** Modelo configurado en el despliegue (Parameter Store): no se asume ninguno por defecto. */
  model: string;
  /** Idioma de las descripciones. */
  language?: string;
  policy?: HttpPolicy;
  http?: HttpDependencies;
  url?: string;
}

export function createOpenAiProposer({
  apiKey,
  model,
  language = 'Spanish',
  policy = OPENAI_HTTP_POLICY,
  http = {},
  url = OPENAI_RESPONSES_URL,
}: OpenAiProposerOptions): SongProposer {
  return {
    async propose(request) {
      const { json } = await requestJson(
        'OpenAI proposal',
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            // No se conservan en OpenAI las propuestas editoriales.
            store: false,
            input: [
              { role: 'system', content: buildInstructions(language) },
              { role: 'user', content: buildRequestInput(request) },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: 'song_candidates',
                strict: true,
                schema: RESPONSE_SCHEMA,
              },
            },
          }),
        },
        policy,
        http,
      );
      return parseProposals(extractOutputText(json));
    },
  };
}
