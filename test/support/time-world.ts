import { vi } from 'vitest';
import { createEditorialSelector } from '../../src/music-selection/selector.ts';
import { createOpenAiProposer, OPENAI_RESPONSES_URL } from '../../src/music-selection/proposer.ts';
import { createClientCredentialsProvider, SPOTIFY_TOKEN_URL } from '../../src/spotify/auth.ts';
import { createSpotifyClient, SPOTIFY_API_URL } from '../../src/spotify/client.ts';
import { findIncompleteFields } from '../../src/tracks/completeness.ts';
import type { GenerateDailyTrackDependencies } from '../../src/tracks/generate-daily-track.ts';
import { InMemoryTrackRepository } from '../../src/tracks/in-memory-repository.ts';
import { readAllTracks } from '../../src/tracks/read-all.ts';
import { createTimeBudget } from '../../src/shared/time-budget.ts';
import { spotifyId } from './music.ts';

export type CallKind = 'openai' | 'token' | 'search' | 'track';

export interface WorldOptions {
  /** Cuánto tarda cada respuesta de OpenAI (avanza el reloj falso). */
  openaiMs?: number;
  /** Cuánto tarda cada llamada a Spotify. */
  spotifyMs?: number;
  /** ¿Spotify encuentra la canción propuesta número n? */
  found?: (n: number) => boolean;
  /** Respuestas a medida; devolver undefined deja el comportamiento normal. */
  override?: (kind: CallKind, callIndex: number) => Response | undefined;
  /** Requiere `vi.useFakeTimers({ toFake: ['Date'] })`: Date.now() sigue al reloj del mundo. */
  syncDate?: boolean;
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);

/**
 * Mundo cerrado con reloj falso: OpenAI, Spotify y el repositorio son simulados, pero el
 * selector, el proposer, el cliente de Spotify y `requestJson` son los reales. fetch y sleep
 * avanzan el reloj y cuentan cada llamada.
 */
export function createTimeWorld({
  openaiMs = 0,
  spotifyMs = 0,
  found = () => true,
  override,
  syncDate = false,
}: WorldOptions = {}) {
  let clock = 0;
  const tick = (ms: number) => {
    clock += ms;
    if (syncDate) vi.setSystemTime(clock);
  };
  if (syncDate) vi.setSystemTime(0);
  const now = () => clock;
  const calls: { kind: CallKind; startedAt: number }[] = [];
  const sleeps: number[] = [];
  let proposalCount = 0;

  const countOf = (kind: CallKind) => calls.filter((call) => call.kind === kind).length;

  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let kind: CallKind;
    if (url === OPENAI_RESPONSES_URL) kind = 'openai';
    else if (url === SPOTIFY_TOKEN_URL) kind = 'token';
    else if (url.startsWith(`${SPOTIFY_API_URL}/search`)) kind = 'search';
    else if (url.startsWith(`${SPOTIFY_API_URL}/tracks/`)) kind = 'track';
    else return Promise.reject(new Error('unexpected url'));

    const callIndex = countOf(kind);
    calls.push({ kind, startedAt: clock });
    tick(kind === 'openai' ? openaiMs : spotifyMs);

    const forced = override?.(kind, callIndex);
    if (forced) return Promise.resolve(forced);

    if (kind === 'token') return Promise.resolve(json({ access_token: 'T', expires_in: 3600 }));

    if (kind === 'openai') {
      proposalCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        text: {
          format: {
            schema: {
              properties: {
                candidates: { items: { properties: { reason: { enum: string[] } } } };
              };
            };
          };
        };
      };
      const reasons = body.text.format.schema.properties.candidates.items.properties.reason.enum;
      const text = JSON.stringify({
        candidates: [
          {
            title: `Song ${proposalCount}`,
            artist: `Artist ${proposalCount}`,
            releaseYear: 1990,
            reason: reasons[0],
            traits: ['mood-nocturnal', 'synths-enveloping', 'rhythm-steady'],
          },
        ],
      });
      return Promise.resolve(
        json({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }),
      );
    }

    const rawTrack = (n: number) => ({
      id: spotifyId(n),
      type: 'track',
      name: `Song ${n}`,
      artists: [{ id: `artist${String(n).padStart(16, '0')}`, name: `Artist ${n}` }],
      album: { name: 'Album', album_type: 'album', release_date: '1990-06-01', images: [] },
    });
    if (kind === 'search') {
      const q = new URL(url).searchParams.get('q') ?? '';
      const n = Number(/\d+/.exec(q)?.[0]);
      return Promise.resolve(json({ tracks: { items: found(n) ? [rawTrack(n)] : [] } }));
    }
    const n = Number(/(\d+)$/.exec(new URL(url).pathname)?.[1] ?? 0);
    return Promise.resolve(json(rawTrack(n)));
  });

  const sleep = (ms: number) => {
    sleeps.push(ms);
    tick(ms);
    return Promise.resolve();
  };
  const http = { fetch: fetchMock as unknown as typeof fetch, sleep, random: () => 0.5 };

  const repository = new InMemoryTrackRepository();
  const spotify = createSpotifyClient({
    tokens: createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'secret',
      http,
      now: () => 0,
    }),
    http,
  });
  const selector = createEditorialSelector({
    proposer: createOpenAiProposer({ apiKey: 'k', model: 'm', http }),
    spotify,
    repository,
  });
  const dependencies: GenerateDailyTrackDependencies = {
    repository,
    selector,
    spotify,
    now: () => new Date('2026-11-21T13:00:00Z'),
  };

  return {
    dependencies,
    repository,
    fetchMock,
    calls,
    sleeps,
    countOf,
    now,
    advance: tick,
    /** Presupuesto nuevo para una invocación que vence `totalMs` después de ahora. */
    budget: (totalMs: number, reserveMs = 20_000) =>
      createTimeBudget({ deadlineMs: clock + totalMs, reserveMs, now }),
  };
}

/** Todo lo guardado está completo (nunca queda un registro a medias). */
export async function expectOnlyCompleteTracks(repository: InMemoryTrackRepository) {
  const tracks = await readAllTracks(repository);
  for (const track of tracks) {
    if (findIncompleteFields(track).length > 0) {
      throw new Error(`Incomplete track stored for ${track.date}`);
    }
  }
  return tracks;
}
