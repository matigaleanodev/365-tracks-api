// Diagnóstico de Spotify con las credenciales de la app (client credentials): solo lee. Uso:
//   AWS_PROFILE=<perfil> node scripts/spotify-check.ts search --title="..." --artist="..." [--market=AR]
//   AWS_PROFILE=<perfil> node scripts/spotify-check.ts track --id=<22 caracteres> [--market=AR]
//   AWS_PROFILE=<perfil> node scripts/spotify-check.ts verify-catalog [--market=AR]
// `verify-catalog` comprueba que cada canción todavía no publicada siga existiendo en Spotify con
// el mismo título y artista y, con --market, que sea reproducible en ese mercado. No escribe nada.
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { REGION, SSM_PREFIX, TABLE_NAME } from '../infra/delivery.ts';
import { PARAMETER_KEYS, readParameters, SsmParameterStore } from '../src/config/parameters.ts';
import { DEFAULT_HTTP_POLICY, HttpError, requestJson } from '../src/shared/resilient-fetch.ts';
import { createClientCredentialsProvider } from '../src/spotify/auth.ts';
import { parseSpotifyTrack, SPOTIFY_API_URL, SPOTIFY_ID_PATTERN } from '../src/spotify/client.ts';
import { normalizeText } from '../src/spotify/matching.ts';
import { listCatalog } from '../src/tracks/catalog-list.ts';
import { DynamoTrackRepository } from '../src/tracks/dynamo-repository.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    artist: { type: 'string' },
    id: { type: 'string' },
    market: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command] = positionals;
if (command !== 'search' && command !== 'track' && command !== 'verify-catalog') {
  fail(
    'Usage: node scripts/spotify-check.ts <search --title --artist|track --id|verify-catalog> [--market=XX]',
  );
}
if (!process.env.AWS_PROFILE) fail('Set AWS_PROFILE: credentials are read from Parameter Store.');
const market = values.market?.toUpperCase();
if (market !== undefined && !/^[A-Z]{2}$/.test(market))
  fail('--market must be an ISO 3166-1 alpha-2 code');

const parameters = await readParameters(
  new SsmParameterStore(new SSMClient({ region: REGION })),
  SSM_PREFIX,
  [PARAMETER_KEYS.spotifyClientId, PARAMETER_KEYS.spotifyClientSecret],
);
const tokens = createClientCredentialsProvider({
  clientId: parameters.require(PARAMETER_KEYS.spotifyClientId),
  clientSecret: parameters.require(PARAMETER_KEYS.spotifyClientSecret),
});

async function get(path: string, query: Record<string, string>): Promise<unknown> {
  const params = new URLSearchParams({ ...query, ...(market && { market }) });
  const { json } = await requestJson(
    `Spotify ${path}`,
    `${SPOTIFY_API_URL}${path}?${params.toString()}`,
    { headers: { authorization: `Bearer ${await tokens.getAccessToken()}` } },
    DEFAULT_HTTP_POLICY,
  );
  return json;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resumen de un track crudo: lo que valida el sistema más los campos que dependen del mercado. */
function summarize(raw: unknown) {
  const track = parseSpotifyTrack(raw);
  const record = isRecord(raw) ? raw : {};
  return {
    valid: track !== null,
    id: track?.id ?? record.id,
    title: track?.title ?? record.name,
    artist: track?.artist,
    album: track?.album,
    releaseYear: track?.releaseYear,
    // Solo vienen con `market`: reproducible y, si Spotify relinkeó, el ID original pedido.
    isPlayable: record.is_playable,
    linkedFrom: isRecord(record.linked_from) ? record.linked_from.id : undefined,
    restrictions: isRecord(record.restrictions) ? record.restrictions.reason : undefined,
  };
}

async function getTrack(id: string): Promise<ReturnType<typeof summarize> & { error?: string }> {
  try {
    return summarize(await get(`/tracks/${id}`, {}));
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 400)) {
      return { ...summarize(null), id, error: `HTTP ${error.status}` };
    }
    throw error;
  }
}

console.log(`market: ${market ?? '(none)'}`);
if (command === 'search') {
  if (!values.title || !values.artist) fail('search needs --title and --artist');
  const json = await get('/search', {
    q: `track:"${values.title}" artist:"${values.artist}"`,
    type: 'track',
    limit: '10',
  });
  const items = isRecord(json) && isRecord(json.tracks) ? json.tracks.items : [];
  console.log(JSON.stringify((Array.isArray(items) ? items : []).map(summarize), null, 2));
} else if (command === 'track') {
  if (!values.id || !SPOTIFY_ID_PATTERN.test(values.id)) fail('--id must be a 22-character id');
  console.log(JSON.stringify(await getTrack(values.id), null, 2));
} else {
  const repository = new DynamoTrackRepository(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
    TABLE_NAME,
  );
  const { entries } = await listCatalog(repository, new Date());
  const pending = entries.filter((entry) => entry.status !== 'published');
  let problems = 0;
  for (const entry of pending) {
    const found = await getTrack(entry.spotifyTrackId);
    const issues: string[] = [];
    if (!found.valid) issues.push(`not available (${found.error ?? 'invalid'})`);
    if (found.valid && normalizeText(String(found.title)) !== normalizeText(entry.title))
      issues.push(`title is "${String(found.title)}"`);
    if (found.valid && normalizeText(String(found.artist)) !== normalizeText(entry.artist))
      issues.push(`artist is "${String(found.artist)}"`);
    if (market && found.isPlayable === false) issues.push(`not playable in ${market}`);
    if (issues.length > 0) problems += 1;
    console.log(`${entry.date} · ${entry.spotifyTrackId} · ${issues.join('; ') || 'ok'}`);
  }
  console.log(`checked ${pending.length} upcoming tracks · ${problems} with issues`);
  process.exit(problems > 0 ? 2 : 0);
}
