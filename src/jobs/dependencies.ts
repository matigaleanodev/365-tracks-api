import { createRotationPersister } from '../config/spotify-secrets-sync.ts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  PARAMETER_KEYS,
  parameterName,
  readParameters,
  SsmParameterStore,
  type ParameterStore,
} from '../config/parameters.ts';
import { parseCriteriaWeights } from '../music-selection/criteria.ts';
import { createEditorialSelector } from '../music-selection/selector.ts';
import { createOpenAiProposer } from '../music-selection/proposer.ts';
import { DynamoPlaylistState } from '../playlist/dynamo-state.ts';
import type { SyncDependencies } from '../playlist/sync.ts';
import { createClientCredentialsProvider, createRefreshTokenProvider } from '../spotify/auth.ts';
import { createSpotifyClient } from '../spotify/client.ts';
import { createSpotifyPlaylistClient } from '../spotify/playlist-client.ts';
import { createTrackRepository } from '../tracks/create-repository.ts';
import type { GenerateDailyTrackDependencies } from '../tracks/generate-daily-track.ts';

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

/**
 * Dependencias reales de la reposición del catálogo. Lee las credenciales de Parameter Store al
 * primer uso (no al importar el módulo) y quien llama las conserva mientras viva la instancia.
 */
export async function createCatalogDependencies(
  env: NodeJS.ProcessEnv,
  store: ParameterStore = new SsmParameterStore(new SSMClient({})),
): Promise<GenerateDailyTrackDependencies> {
  const prefix = requiredEnv(env, 'SSM_PARAMETER_PREFIX');
  const parameters = await readParameters(store, prefix, [
    PARAMETER_KEYS.spotifyClientId,
    PARAMETER_KEYS.spotifyClientSecret,
    PARAMETER_KEYS.openaiApiKey,
    PARAMETER_KEYS.openaiModel,
    PARAMETER_KEYS.criteriaWeights,
  ]);

  const repository = createTrackRepository(env, new Date());
  const spotify = createSpotifyClient({
    tokens: createClientCredentialsProvider({
      clientId: parameters.require(PARAMETER_KEYS.spotifyClientId),
      clientSecret: parameters.require(PARAMETER_KEYS.spotifyClientSecret),
    }),
  });
  const selector = createEditorialSelector({
    proposer: createOpenAiProposer({
      apiKey: parameters.require(PARAMETER_KEYS.openaiApiKey),
      model: parameters.require(PARAMETER_KEYS.openaiModel),
    }),
    spotify,
    repository,
    weights: parseCriteriaWeights(parameters.optional(PARAMETER_KEYS.criteriaWeights)),
  });
  return { repository, selector, spotify, now: () => new Date() };
}

/** Dependencias reales de la sincronización de la playlist (cuenta propietaria de Spotify). */
export async function createPlaylistDependencies(
  env: NodeJS.ProcessEnv,
  store: ParameterStore = new SsmParameterStore(new SSMClient({})),
): Promise<SyncDependencies> {
  const prefix = requiredEnv(env, 'SSM_PARAMETER_PREFIX');
  const tableName = requiredEnv(env, 'TRACKS_TABLE_NAME');
  const parameters = await readParameters(store, prefix, [
    PARAMETER_KEYS.spotifyClientId,
    PARAMETER_KEYS.spotifyClientSecret,
    PARAMETER_KEYS.spotifyRefreshToken,
  ]);

  const persistRotated = createRotationPersister(
    store,
    parameterName(prefix, PARAMETER_KEYS.spotifyRefreshToken),
    parameters.require(PARAMETER_KEYS.spotifyRefreshToken),
  );
  const tokens = createRefreshTokenProvider({
    clientId: parameters.require(PARAMETER_KEYS.spotifyClientId),
    clientSecret: parameters.require(PARAMETER_KEYS.spotifyClientSecret),
    refreshToken: parameters.require(PARAMETER_KEYS.spotifyRefreshToken),
    // Única escritura posible fuera de `syncPlaylists`, también en dry-run: guardar en Parameter
    // Store el refresh token que Spotify rotó (descartarlo podría invalidar la autorización).
    // `put` se invoca solo ante rotación; nunca modifica playlists ni registros de sincronización.
    // Si otro proceso ya reemplazó el parámetro (sincronización o reautorización), no lo pisa: esta
    // instancia caliente partió de un token viejo.
    onRefreshTokenRotated: async (token) => {
      if (!(await persistRotated(token))) {
        console.warn(JSON.stringify({ event: 'refresh-token-superseded' }));
      }
    },
  });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    tracks: createTrackRepository(env, new Date()),
    state: new DynamoPlaylistState(documentClient, tableName),
    playlists: createSpotifyPlaylistClient({ tokens }),
    now: () => new Date(),
  };
}
