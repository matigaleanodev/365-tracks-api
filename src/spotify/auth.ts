import {
  DEFAULT_HTTP_POLICY,
  HttpError,
  requestJson,
  type HttpDependencies,
  type HttpPolicy,
} from '../shared/resilient-fetch.ts';
import { SpotifyAuthError } from './errors.ts';

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

interface ProviderOptions {
  clientId: string;
  clientSecret: string;
  policy?: HttpPolicy;
  http?: HttpDependencies;
  now?: () => number;
  tokenUrl?: string;
}

/** Margen para no usar un token que vence durante la llamada. */
const EXPIRY_SKEW_MS = 60_000;

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function parseTokenResponse(json: unknown): { accessToken: string; expiresInMs: number } & {
  refreshToken?: string;
} {
  const body = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken } = body;
  if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number') {
    throw new SpotifyAuthError('unavailable', 'Spotify token response is invalid');
  }
  return {
    accessToken,
    expiresInMs: expiresIn * 1000,
    ...(typeof refreshToken === 'string' && refreshToken !== '' && { refreshToken }),
  };
}

function toAuthError(error: unknown): never {
  if (error instanceof HttpError && error.kind === 'client-error') {
    if (error.body.includes('invalid_grant')) {
      throw new SpotifyAuthError(
        'invalid_grant',
        'Spotify refresh token is expired or revoked: repeat the initial authorization',
      );
    }
    throw new SpotifyAuthError(
      'invalid_client',
      `Spotify rejected the credentials (HTTP ${error.status})`,
    );
  }
  if (error instanceof SpotifyAuthError) throw error;
  throw new SpotifyAuthError(
    'unavailable',
    error instanceof Error ? error.message : 'Spotify token endpoint is unavailable',
  );
}

/** Token en memoria con una sola renovación en vuelo aunque haya llamadas concurrentes. */
function cachedProvider(
  fetchToken: () => Promise<{ accessToken: string; expiresInMs: number }>,
  now: () => number,
): AccessTokenProvider {
  let token: { value: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  return {
    getAccessToken() {
      if (token && now() < token.expiresAt) {
        return Promise.resolve(token.value);
      }
      inFlight ??= fetchToken()
        .then(({ accessToken, expiresInMs }) => {
          token = { value: accessToken, expiresAt: now() + expiresInMs - EXPIRY_SKEW_MS };
          return accessToken;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}

/** Catálogo público (búsqueda, metadatos): no hay usuario ni refresh token. */
export function createClientCredentialsProvider({
  clientId,
  clientSecret,
  policy = DEFAULT_HTTP_POLICY,
  http = {},
  now = Date.now,
  tokenUrl = SPOTIFY_TOKEN_URL,
}: ProviderOptions): AccessTokenProvider {
  return cachedProvider(async () => {
    try {
      const { json } = await requestJson(
        'Spotify token request',
        tokenUrl,
        {
          method: 'POST',
          headers: {
            authorization: basicAuthorization(clientId, clientSecret),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
        },
        policy,
        http,
      );
      return parseTokenResponse(json);
    } catch (error) {
      return toAuthError(error);
    }
  }, now);
}

export interface RefreshTokenProviderOptions extends ProviderOptions {
  refreshToken: string;
  /**
   * Spotify puede entregar un refresh token nuevo al renovar. Si ocurre, hay que guardarlo antes
   * de seguir: el anterior puede dejar de valer.
   */
  onRefreshTokenRotated?: (refreshToken: string) => Promise<void>;
}

/** Cuenta propietaria de la playlist: renueva el access token con el refresh token guardado. */
export function createRefreshTokenProvider({
  clientId,
  clientSecret,
  refreshToken,
  onRefreshTokenRotated,
  policy = DEFAULT_HTTP_POLICY,
  http = {},
  now = Date.now,
  tokenUrl = SPOTIFY_TOKEN_URL,
}: RefreshTokenProviderOptions): AccessTokenProvider {
  let currentRefreshToken = refreshToken;
  return cachedProvider(async () => {
    try {
      const { json } = await requestJson(
        'Spotify token refresh',
        tokenUrl,
        {
          method: 'POST',
          headers: {
            authorization: basicAuthorization(clientId, clientSecret),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: currentRefreshToken,
          }).toString(),
        },
        policy,
        http,
      );
      const parsed = parseTokenResponse(json);
      if (parsed.refreshToken !== undefined && parsed.refreshToken !== currentRefreshToken) {
        await onRefreshTokenRotated?.(parsed.refreshToken);
        currentRefreshToken = parsed.refreshToken;
      }
      return parsed;
    } catch (error) {
      return toAuthError(error);
    }
  }, now);
}
