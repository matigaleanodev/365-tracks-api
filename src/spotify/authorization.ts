import {
  DEFAULT_HTTP_POLICY,
  HttpError,
  requestJson,
  type HttpDependencies,
} from '../shared/resilient-fetch.ts';
import { SPOTIFY_TOKEN_URL } from './auth.ts';
import { SpotifyAuthError } from './errors.ts';

/**
 * Permiso mínimo para administrar una playlist pública propia. No se piden permisos de lectura de
 * biblioteca, reproducción ni playlists privadas: la playlist anual es pública.
 */
export const PLAYLIST_SCOPES = ['playlist-modify-public'] as const;

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

/** Spotify exige https salvo loopback por IP literal (nunca `localhost`). */
export function isValidRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  if (!isValidRedirectUri(options.redirectUri)) {
    throw new Error('redirectUri must be https, or http on a loopback IP literal (127.0.0.1)');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: (options.scopes ?? PLAYLIST_SCOPES).join(' '),
    state: options.state,
    // Un consentimiento nuevo cada vez: el script se ejecuta a propósito.
    show_dialog: 'true',
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

/** Valida la redirección de Spotify y extrae el código. Rechaza `state` ajeno o errores. */
export function parseAuthorizationCallback(callbackUrl: string, expectedState: string): string {
  const url = new URL(callbackUrl, 'http://127.0.0.1');
  const error = url.searchParams.get('error');
  if (error !== null) {
    throw new SpotifyAuthError('invalid_grant', `Spotify authorization was denied: ${error}`);
  }
  if (url.searchParams.get('state') !== expectedState) {
    throw new SpotifyAuthError('invalid_grant', 'Authorization callback state does not match');
  }
  const code = url.searchParams.get('code');
  if (code === null || code === '') {
    throw new SpotifyAuthError('invalid_grant', 'Authorization callback has no code');
  }
  return code;
}

/** Canjea el código por el refresh token del dueño. El valor nunca se imprime ni se registra. */
export async function exchangeAuthorizationCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  http?: HttpDependencies;
}): Promise<{ refreshToken: string }> {
  try {
    const { json } = await requestJson(
      'Spotify authorization code exchange',
      SPOTIFY_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: options.code,
          redirect_uri: options.redirectUri,
        }).toString(),
      },
      // El código es de un solo uso: un reintento ambiguo lo invalidaría.
      { ...DEFAULT_HTTP_POLICY, retryAmbiguousFailures: false },
      options.http,
    );
    const refreshToken =
      typeof json === 'object' && json !== null
        ? (json as Record<string, unknown>).refresh_token
        : undefined;
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new SpotifyAuthError('unavailable', 'Spotify did not return a refresh token');
    }
    return { refreshToken };
  } catch (error) {
    if (error instanceof SpotifyAuthError) throw error;
    if (error instanceof HttpError && error.kind === 'client-error') {
      throw new SpotifyAuthError(
        'invalid_grant',
        `Spotify rejected the code (HTTP ${error.status})`,
      );
    }
    throw error;
  }
}
