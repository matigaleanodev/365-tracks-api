import { describe, expect, it, vi } from 'vitest';
import {
  createClientCredentialsProvider,
  createRefreshTokenProvider,
} from '../../src/spotify/auth.ts';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isValidRedirectUri,
  parseAuthorizationCallback,
  PLAYLIST_SCOPES,
} from '../../src/spotify/authorization.ts';
import { SpotifyAuthError } from '../../src/spotify/errors.ts';
import { HttpError, type HttpPolicy } from '../../src/shared/resilient-fetch.ts';
import { createTimeBudget, TimeBudgetExhaustedError } from '../../src/shared/time-budget.ts';

const policy: HttpPolicy = {
  timeoutMs: 1000,
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 1,
  maxRetryAfterMs: 1,
};

const token = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status });

function fetchOf(responses: Response[]) {
  const queue = [...responses];
  return vi.fn(() => {
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected request'));
  });
}

const http = (mock: ReturnType<typeof vi.fn>) => ({
  fetch: mock as unknown as typeof fetch,
  sleep: () => Promise.resolve(),
});

const bodyOf = (mock: ReturnType<typeof vi.fn>, call = 0) =>
  (mock.mock.calls[call] as unknown as [string, RequestInit])[1].body as string;

describe('client credentials', () => {
  it('obtiene un token con Basic auth y lo reutiliza hasta que vence', async () => {
    const fetchMock = fetchOf([token({ access_token: 'T1', expires_in: 3600 })]);
    let clock = 0;
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'secret',
      policy,
      http: http(fetchMock),
      now: () => clock,
    });

    expect(await provider.getAccessToken()).toBe('T1');
    clock = 3_000_000; // dentro de la vigencia
    expect(await provider.getAccessToken()).toBe('T1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    expect(init.body).toBe('grant_type=client_credentials');
  });

  it('renueva antes de vencer (margen de 60 s)', async () => {
    const fetchMock = fetchOf([
      token({ access_token: 'T1', expires_in: 3600 }),
      token({ access_token: 'T2', expires_in: 3600 }),
    ]);
    let clock = 0;
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 's',
      policy,
      http: http(fetchMock),
      now: () => clock,
    });
    await provider.getAccessToken();
    clock = 3_541_000;
    expect(await provider.getAccessToken()).toBe('T2');
  });

  it('llamadas concurrentes comparten una sola renovación', async () => {
    const fetchMock = fetchOf([token({ access_token: 'T1', expires_in: 3600 })]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 's',
      policy,
      http: http(fetchMock),
    });
    const tokens = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(tokens).toEqual(['T1', 'T1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('credenciales rechazadas → invalid_client', async () => {
    const fetchMock = fetchOf([token({ error: 'invalid_client' }, 401)]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'bad',
      policy,
      http: http(fetchMock),
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      name: 'SpotifyAuthError',
      failure: 'invalid_client',
    });
  });

  it.each([501, 507, 511])(
    'un %i del endpoint de token → unavailable, no invalid_client',
    async (status) => {
      const fetchMock = fetchOf([token({ error: 'server' }, status)]);
      const provider = createClientCredentialsProvider({
        clientId: 'id',
        clientSecret: 's',
        policy,
        http: http(fetchMock),
      });
      await expect(provider.getAccessToken()).rejects.toMatchObject({
        name: 'SpotifyAuthError',
        failure: 'unavailable',
      });
    },
  );

  it('una respuesta sin token → unavailable', async () => {
    const fetchMock = fetchOf([token({ nope: true })]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 's',
      policy,
      http: http(fetchMock),
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('refresh token del dueño: 5xx', () => {
  it('un 507 al renovar → unavailable y no se guarda nada', async () => {
    const onRotated = vi.fn(() => Promise.resolve());
    const provider = createRefreshTokenProvider({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'R1',
      onRefreshTokenRotated: onRotated,
      policy,
      http: http(fetchOf([token({}, 507)])),
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({ failure: 'unavailable' });
    expect(onRotated).not.toHaveBeenCalled();
  });
});

describe('refresh token del dueño', () => {
  const make = (responses: Response[], onRotated = vi.fn(() => Promise.resolve())) => {
    const fetchMock = fetchOf(responses);
    const provider = createRefreshTokenProvider({
      clientId: 'id',
      clientSecret: 's',
      refreshToken: 'R1',
      onRefreshTokenRotated: onRotated,
      policy,
      http: http(fetchMock),
    });
    return { provider, fetchMock, onRotated };
  };

  it('renueva con grant_type=refresh_token', async () => {
    const { provider, fetchMock } = make([token({ access_token: 'A', expires_in: 3600 })]);
    await provider.getAccessToken();
    expect(new URLSearchParams(bodyOf(fetchMock)).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(bodyOf(fetchMock)).get('refresh_token')).toBe('R1');
  });

  it('guarda un refresh token rotado antes de seguir y usa el nuevo después', async () => {
    const order: string[] = [];
    const onRotated = vi.fn(() => {
      order.push('saved');
      return Promise.resolve();
    });
    const { provider, fetchMock } = make(
      [
        token({ access_token: 'A', expires_in: 1, refresh_token: 'R2' }),
        token({ access_token: 'B', expires_in: 3600 }),
      ],
      onRotated,
    );
    await provider.getAccessToken();
    expect(onRotated).toHaveBeenCalledWith('R2');
    expect(order).toEqual(['saved']);

    await provider.getAccessToken(); // expires_in 1 s ⇒ ya vencido por el margen
    expect(new URLSearchParams(bodyOf(fetchMock, 1)).get('refresh_token')).toBe('R2');
  });

  it('no guarda nada si el refresh token no cambió', async () => {
    const { provider, onRotated } = make([
      token({ access_token: 'A', expires_in: 3600, refresh_token: 'R1' }),
    ]);
    await provider.getAccessToken();
    expect(onRotated).not.toHaveBeenCalled();
  });

  it('invalid_grant (vencido o revocado) se informa para repetir la autorización', async () => {
    const { provider } = make([token({ error: 'invalid_grant' }, 400)]);
    const error = (await provider.getAccessToken().catch((e: unknown) => e)) as SpotifyAuthError;
    expect(error).toBeInstanceOf(SpotifyAuthError);
    expect(error.failure).toBe('invalid_grant');
    expect(error.message).not.toContain('R1');
  });
});

describe('autorización inicial del dueño', () => {
  it('pide solo el permiso mínimo para una playlist pública', () => {
    expect(PLAYLIST_SCOPES).toEqual(['playlist-modify-public']);
  });

  it.each([
    ['http://127.0.0.1:8888/callback', true],
    ['http://[::1]:8888/callback', true],
    ['https://example.com/callback', true],
    ['http://localhost:8888/callback', false],
    ['http://example.com/callback', false],
    ['no es una url', false],
  ])('redirect %s válido: %s', (uri, valid) => {
    expect(isValidRedirectUri(uri)).toBe(valid);
  });

  it('arma la URL con scope mínimo y state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:8888/callback',
        state: 'abc',
      }),
    );
    expect(url.searchParams.get('scope')).toBe('playlist-modify-public');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(() =>
      buildAuthorizeUrl({ clientId: 'c', redirectUri: 'http://localhost:1/x', state: 's' }),
    ).toThrow(/loopback/);
  });

  it('valida el callback: código, state y errores', () => {
    expect(parseAuthorizationCallback('/callback?code=XYZ&state=abc', 'abc')).toBe('XYZ');
    expect(() => parseAuthorizationCallback('/callback?code=XYZ&state=otro', 'abc')).toThrow(
      /state/,
    );
    expect(() => parseAuthorizationCallback('/callback?state=abc', 'abc')).toThrow(/no code/);
    expect(() =>
      parseAuthorizationCallback('/callback?error=access_denied&state=abc', 'abc'),
    ).toThrow(/denied/);
  });

  it('canjea el código y devuelve solo el refresh token', async () => {
    const fetchMock = fetchOf([token({ access_token: 'A', refresh_token: 'R', expires_in: 3600 })]);
    const result = await exchangeAuthorizationCode({
      clientId: 'id',
      clientSecret: 's',
      code: 'CODE',
      redirectUri: 'http://127.0.0.1:8888/callback',
      http: http(fetchMock),
    });
    expect(result).toEqual({ refreshToken: 'R' });
  });

  it('un código rechazado → invalid_grant; sin refresh token → unavailable', async () => {
    const base = {
      clientId: 'id',
      clientSecret: 's',
      code: 'C',
      redirectUri: 'http://127.0.0.1:8888/callback',
    };
    await expect(
      exchangeAuthorizationCode({ ...base, http: http(fetchOf([token({ error: 'x' }, 400)])) }),
    ).rejects.toMatchObject({ failure: 'invalid_grant' });
    await expect(
      exchangeAuthorizationCode({ ...base, http: http(fetchOf([token({ access_token: 'A' })])) }),
    ).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it.each([501, 507])(
    'un %i al canjear el código se propaga como error HTTP del servidor, nunca como invalid_grant',
    async (status) => {
      const error = await exchangeAuthorizationCode({
        clientId: 'id',
        clientSecret: 's',
        code: 'C',
        redirectUri: 'http://127.0.0.1:8888/callback',
        http: http(fetchOf([token({ error: 'server' }, status)])),
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ kind: 'server-error', status });
      expect(error).not.toBeInstanceOf(SpotifyAuthError);
    },
  );
});

describe('presupuesto de tiempo en el token', () => {
  it('un presupuesto agotado sale tal cual, sin envolverse como SpotifyAuthError', async () => {
    const fetchMock = fetchOf([token({ access_token: 'T1', expires_in: 3600 })]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'secret',
      policy,
      http: http(fetchMock),
    });
    const budget = createTimeBudget({ deadlineMs: 500, reserveMs: 0, now: () => 0 });

    const error: unknown = await provider.getAccessToken({ budget }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeBudgetExhaustedError);
    expect(error).not.toBeInstanceOf(SpotifyAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con tiempo suficiente obtiene el token y lo reutiliza sin consultar el presupuesto', async () => {
    const fetchMock = fetchOf([token({ access_token: 'T1', expires_in: 3600 })]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'secret',
      policy,
      http: http(fetchMock),
    });
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 0, now: () => 0 });
    await expect(provider.getAccessToken({ budget })).resolves.toBe('T1');
    const spent = createTimeBudget({ deadlineMs: 0, reserveMs: 0, now: () => 1 });
    await expect(provider.getAccessToken({ budget: spent })).resolves.toBe('T1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('un fallo real de autenticación sigue siendo SpotifyAuthError', async () => {
    const fetchMock = fetchOf([token({ error: 'invalid_client' }, 401)]);
    const provider = createClientCredentialsProvider({
      clientId: 'id',
      clientSecret: 'secret',
      policy,
      http: http(fetchMock),
    });
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 0, now: () => 0 });
    await expect(provider.getAccessToken({ budget })).rejects.toBeInstanceOf(SpotifyAuthError);
  });
});
