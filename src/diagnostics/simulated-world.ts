import type { EditorialCriterion } from '../music-selection/criteria.ts';
import { reasonIdsFor, TRAIT_IDS } from '../music-selection/editorial-vocabulary.ts';
import { normalizeText } from '../spotify/matching.ts';

/**
 * Mundo simulado y determinista para el preview sin red (`--simulate`) y para los tests. Todo es
 * ficticio: los títulos, artistas e IDs no existen en ningún servicio real.
 */

export interface SimSong {
  title: string;
  artist: string;
  album: string;
  releaseYear: number;
  albumType?: string;
  /** ID de Spotify (22 caracteres); se genera a partir de la posición si falta. */
  id?: string;
  artistId?: string;
}

export interface SimCandidate {
  title: string;
  artist: string;
  releaseYear: number;
  /** Por defecto, el primer motivo del criterio pedido. */
  reason?: string;
  /** Por defecto, dos rasgos fijos. */
  traits?: string[];
}

export interface HttpStep {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type OpenAiStep = { candidates: SimCandidate[] } | { text: string } | { http: HttpStep };

export interface OpenAiCall {
  /** Orden de la llamada (desde 0) dentro de este mundo. */
  index: number;
  criterion: EditorialCriterion;
  alreadyConsidered: { title: string; artist: string }[];
}

export interface SpotifyCall {
  index: number;
  method: string;
  path: string;
}

export interface SimulatedRequest {
  method: string;
  host: string;
  path: string;
  /** Solo para inspección en tests; el preview no lo conserva en el informe. */
  body: string | undefined;
}

export interface SimulatedWorldOptions {
  songs: readonly SimSong[];
  openAi: (call: OpenAiCall) => OpenAiStep;
  /** Permite forzar una respuesta HTTP a una llamada de Spotify (por ejemplo un 429). */
  spotifyIntercept?: (call: SpotifyCall) => HttpStep | undefined;
}

export interface SimulatedWorld {
  fetch: typeof fetch;
  requests: readonly SimulatedRequest[];
}

const SIM_ACCESS_TOKEN = 'simulated-access-token';

export const simId = (prefix: string, n: number): string =>
  `${prefix}${String(n).padStart(22 - prefix.length, '0')}`;

const json = ({ status, body, headers = {} }: HttpStep): Response =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const spotifyTrackJson = (song: SimSong, index: number) => {
  const id = song.id ?? simId('sim', index + 1);
  const artistId = song.artistId ?? simId('art', index + 1);
  return {
    id,
    type: 'track',
    name: song.title,
    artists: [{ id: artistId, name: song.artist }],
    album: {
      name: song.album,
      album_type: song.albumType ?? 'album',
      release_date: `${song.releaseYear}-06-01`,
      images: [{ url: `https://i.scdn.co/image/${id}` }],
    },
  };
};

const outputText = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});

function readOpenAiCall(index: number, body: string | undefined): OpenAiCall {
  const fallback: OpenAiCall = { index, criterion: 'classic', alreadyConsidered: [] };
  try {
    const request = JSON.parse(body ?? '') as { input: { content: string }[] };
    const user = JSON.parse(request.input[1]?.content ?? '') as {
      criterion: EditorialCriterion;
      alreadyConsidered: { title: string; artist: string }[];
    };
    return { index, criterion: user.criterion, alreadyConsidered: user.alreadyConsidered };
  } catch {
    return fallback;
  }
}

function openAiResponse(step: OpenAiStep, criterion: EditorialCriterion): Response {
  if ('http' in step) return json(step.http);
  if ('text' in step) return json({ status: 200, body: outputText(step.text) });
  const reasons = reasonIdsFor(criterion);
  const candidates = step.candidates.map((candidate) => ({
    title: candidate.title,
    artist: candidate.artist,
    releaseYear: candidate.releaseYear,
    reason: candidate.reason ?? reasons[0],
    traits: candidate.traits ?? ['mood-warm', 'rhythm-steady'],
  }));
  return json({ status: 200, body: outputText(JSON.stringify({ candidates })) });
}

/**
 * Fetch simulado para `api.openai.com`, `api.spotify.com` y `accounts.spotify.com`. Cualquier otro
 * destino responde 404 (y queda registrado). No hace red.
 */
export function createSimulatedWorld({
  songs,
  openAi,
  spotifyIntercept,
}: SimulatedWorldOptions): SimulatedWorld {
  const requests: SimulatedRequest[] = [];
  let openAiCalls = 0;
  let spotifyCalls = 0;

  const simulated: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ method, host: url.host, path: url.pathname, body });

    if (url.host === 'accounts.spotify.com' && url.pathname === '/api/token') {
      return Promise.resolve(
        json({
          status: 200,
          body: { access_token: SIM_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 },
        }),
      );
    }

    if (url.host === 'api.openai.com' && url.pathname === '/v1/responses') {
      const call = readOpenAiCall(openAiCalls, body);
      openAiCalls += 1;
      return Promise.resolve(openAiResponse(openAi(call), call.criterion));
    }

    if (url.host === 'api.spotify.com') {
      const forced = spotifyIntercept?.({ index: spotifyCalls, method, path: url.pathname });
      spotifyCalls += 1;
      if (forced) return Promise.resolve(json(forced));

      if (url.pathname === '/v1/search') {
        const query = normalizeText(url.searchParams.get('q') ?? '');
        const items = songs.flatMap((song, index) =>
          query.includes(normalizeText(song.title)) && query.includes(normalizeText(song.artist))
            ? [spotifyTrackJson(song, index)]
            : [],
        );
        return Promise.resolve(json({ status: 200, body: { tracks: { items } } }));
      }
      const trackId = /^\/v1\/tracks\/([A-Za-z0-9]{22})$/.exec(url.pathname)?.[1];
      if (trackId !== undefined) {
        const index = songs.findIndex((song, i) => (song.id ?? simId('sim', i + 1)) === trackId);
        const song = songs[index];
        return Promise.resolve(
          song === undefined
            ? json({ status: 404, body: { error: { status: 404 } } })
            : json({ status: 200, body: spotifyTrackJson(song, index) }),
        );
      }
    }
    return Promise.resolve(json({ status: 404, body: { error: 'not simulated' } }));
  };

  return { fetch: simulated, requests };
}

/** Catálogo ficticio del modo `--simulate`. */
export const DEFAULT_SIMULATED_SONGS: readonly SimSong[] = [
  {
    title: 'Sol en la Ventana',
    artist: 'Orquesta Marfil',
    album: 'Verano Lento',
    releaseYear: 1985,
  },
  {
    title: 'Tren de Medianoche',
    artist: 'Valeria Quintanilla',
    album: 'Luces de Estación',
    releaseYear: 1991,
  },
  { title: 'Camino de Sal', artist: 'Orquesta Marfil', album: 'Costa Adentro', releaseYear: 1987 },
  {
    title: 'Faro de Cristal',
    artist: 'Los Ecos del Sur',
    album: 'Mareas Quietas',
    releaseYear: 1978,
  },
  { title: 'Neón Suave', artist: 'Kiri Tanaka', album: 'Ciudad Líquida', releaseYear: 2016 },
  { title: 'Arena y Cobre', artist: 'Hermanos Lanza', album: 'Polvo Dorado', releaseYear: 1969 },
  {
    title: 'Pequeño Planeta',
    artist: 'Mina Okonkwo',
    album: 'Órbita Doméstica',
    releaseYear: 2003,
  },
  {
    title: 'Lluvia de Marzo',
    artist: 'Tomás Beltrán Trío',
    album: 'Cuaderno Azul',
    releaseYear: 1996,
  },
  { title: 'Humo Violeta', artist: 'Estela Varga', album: 'Sala de Espejos', releaseYear: 2022 },
  { title: 'Danza del Lago', artist: 'Coral Ceniza', album: 'Invierno Abierto', releaseYear: 1974 },
  { title: 'Voz de Papel', artist: 'Noor Haddad', album: 'Cartas sin Sobre', releaseYear: 2011 },
  { title: 'Último Tranvía', artist: 'Los Faroles', album: 'Barrio Alto', releaseYear: 1982 },
  // Solo existe la versión en vivo: la propuesta de estudio se rechaza como `wrong-version`.
  {
    title: 'Ventana Abierta',
    artist: 'Gaspar Ríos',
    album: 'Ventana Abierta (Live at Teatro Sur)',
    releaseYear: 1999,
  },
];

const POOL_SIZE = 12;

/**
 * Guion determinista del modelo simulado: en cada ronda propone una canción inexistente, una con
 * el año equivocado, (cada tres rondas) una cuya única grabación es en vivo y, al final, la
 * siguiente canción del catálogo ficticio con el año correcto. Así el informe muestra rechazos
 * de varios tipos sin depender del azar. El modelo simulado no lee nada de Spotify.
 */
export function defaultOpenAiScenario(songs: readonly SimSong[] = DEFAULT_SIMULATED_SONGS) {
  return ({ index, criterion }: OpenAiCall): OpenAiStep => {
    const reasons = reasonIdsFor(criterion);
    const reason = reasons[index % reasons.length];
    const traitAt = (offset: number) =>
      TRAIT_IDS[(index * 2 + offset) % TRAIT_IDS.length] as string;
    const traits =
      index % 2 === 0 ? [traitAt(0), traitAt(7), traitAt(13)] : [traitAt(0), traitAt(7)];
    const base = { ...(reason !== undefined && { reason }), traits };

    const pool = songs.slice(0, POOL_SIZE);
    const wrongYear = pool[(index * 3 + 5) % pool.length] as SimSong;
    const valid = pool[index % pool.length] as SimSong;
    const candidates: SimCandidate[] = [
      { title: `Eco Perdido ${index + 1}`, artist: 'Banda Imaginaria', releaseYear: 1980, ...base },
      {
        title: wrongYear.title,
        artist: wrongYear.artist,
        releaseYear: wrongYear.releaseYear + 7,
        ...base,
      },
    ];
    const live = songs[POOL_SIZE];
    if (live !== undefined && index % 3 === 0) {
      candidates.push({
        title: live.title,
        artist: live.artist,
        releaseYear: live.releaseYear,
        ...base,
      });
    }
    candidates.push({
      title: valid.title,
      artist: valid.artist,
      releaseYear: valid.releaseYear,
      ...base,
    });
    return { candidates };
  };
}
