import {
  DEFAULT_HTTP_POLICY,
  HttpError,
  requestJson,
  type HttpDependencies,
  type HttpPolicy,
} from '../shared/resilient-fetch.ts';
import { TimeBudgetExhaustedError, type TimeBudget } from '../shared/time-budget.ts';
import { SpotifyAuthError } from './errors.ts';

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

export interface AccessTokenOptions {
  budget?: TimeBudget;
}

export interface AccessTokenProvider {
  getAccessToken(options?: AccessTokenOptions): Promise<string>;
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
  // Quedarse sin tiempo no es un fallo de autenticación: se propaga tal cual.
  if (error instanceof TimeBudgetExhaustedError) throw error;
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
  fetchToken: (
    options: AccessTokenOptions,
  ) => Promise<{ accessToken: string; expiresInMs: number }>,
  now: () => number,
): AccessTokenProvider {
  let token: { value: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  return {
    getAccessToken(options = {}) {
      if (token && now() < token.expiresAt) {
        return Promise.resolve(token.value);
      }
      inFlight ??= fetchToken(options)
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
  return cachedProvider(async ({ budget }) => {
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
        budget === undefined ? http : { ...http, budget },
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
  // Spotify rotó el token y todavía no se pudo guardar: la instancia ya usa el nuevo.
  let rotationPending = false;
  return cachedProvider(async () => {
    let parsed: ReturnType<typeof parseTokenResponse>;
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
      parsed = parseTokenResponse(json);
    } catch (error) {
      return toAuthError(error);
    }
    if (parsed.refreshToken !== undefined && parsed.refreshToken !== currentRefreshToken) {
      // El token anterior no se vuelve a usar aunque no se pueda guardar el nuevo.
      currentRefreshToken = parsed.refreshToken;
      rotationPending = true;
    }
    if (rotationPending && onRefreshTokenRotated) {
      try {
        await onRefreshTokenRotated(currentRefreshToken);
        rotationPending = false;
      } catch {
        // Sin `cause` ni detalle: el error del store podría incluir el valor del token.
        throw new SpotifyAuthError(
          'rotation_not_persisted',
          'Spotify rotated the refresh token but it could not be saved; aborting without using the access token',
        );
      }
    }
    return parsed;
  }, now);
}
