import { describe, expect, it, vi } from 'vitest';
import { createRefreshTokenProvider } from '../../src/spotify/auth.ts';
import { SpotifyAuthError } from '../../src/spotify/errors.ts';
import type { HttpPolicy } from '../../src/shared/resilient-fetch.ts';

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

const refreshTokenSent = (mock: ReturnType<typeof vi.fn>, call: number) =>
  new URLSearchParams(
    (mock.mock.calls[call] as unknown as [string, RequestInit])[1].body as string,
  ).get('refresh_token');

function make(responses: Response[], onRotated: (token: string) => Promise<void>) {
  const fetchMock = fetchOf(responses);
  const provider = createRefreshTokenProvider({
    clientId: 'id',
    clientSecret: 's',
    refreshToken: 'OLD-REFRESH',
    onRefreshTokenRotated: onRotated,
    policy,
    http: { fetch: fetchMock as unknown as typeof fetch, sleep: () => Promise.resolve() },
  });
  return { provider, fetchMock };
}

describe('rotación del refresh token', () => {
  it('persiste el token nuevo una sola vez y lo usa en la siguiente renovación', async () => {
    const onRotated = vi.fn(() => Promise.resolve());
    const { provider, fetchMock } = make(
      [
        token({ access_token: 'A', expires_in: 1, refresh_token: 'NEW-REFRESH' }),
        token({ access_token: 'B', expires_in: 1, refresh_token: 'NEW-REFRESH' }),
        token({ access_token: 'C', expires_in: 3600 }),
      ],
      onRotated,
    );
    expect(await provider.getAccessToken()).toBe('A');
    expect(await provider.getAccessToken()).toBe('B');
    expect(await provider.getAccessToken()).toBe('C');

    expect(onRotated).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledWith('NEW-REFRESH');
    expect(refreshTokenSent(fetchMock, 0)).toBe('OLD-REFRESH');
    expect(refreshTokenSent(fetchMock, 1)).toBe('NEW-REFRESH');
    expect(refreshTokenSent(fetchMock, 2)).toBe('NEW-REFRESH');
  });

  it('sin rotación no se persiste nada', async () => {
    const onRotated = vi.fn(() => Promise.resolve());
    const { provider } = make(
      [
        token({ access_token: 'A', expires_in: 1 }),
        token({ access_token: 'B', expires_in: 1, refresh_token: 'OLD-REFRESH' }),
      ],
      onRotated,
    );
    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(onRotated).not.toHaveBeenCalled();
  });

  it('si no se puede persistir: rotation_not_persisted, sin access token ni token en el error', async () => {
    const onRotated = vi
      .fn<(token: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('AccessDenied while writing NEW-REFRESH'))
      .mockResolvedValue(undefined);
    const { provider, fetchMock } = make(
      [
        token({ access_token: 'A', expires_in: 3600, refresh_token: 'NEW-REFRESH' }),
        token({ access_token: 'B', expires_in: 3600 }),
      ],
      onRotated,
    );

    const error = (await provider.getAccessToken().then(
      (value) => ({ leaked: value }),
      (e: unknown) => e,
    )) as SpotifyAuthError;
    expect(error).toBeInstanceOf(SpotifyAuthError);
    expect(error.failure).toBe('rotation_not_persisted');
    expect(error.message).not.toContain('NEW-REFRESH');
    expect(error.message).not.toContain('OLD-REFRESH');
    expect(error.cause).toBeUndefined();

    // La próxima renovación usa el token nuevo (nunca el viejo) y reintenta guardarlo.
    expect(await provider.getAccessToken()).toBe('B');
    expect(refreshTokenSent(fetchMock, 1)).toBe('NEW-REFRESH');
    expect(onRotated).toHaveBeenCalledTimes(2);
    expect(onRotated).toHaveBeenLastCalledWith('NEW-REFRESH');

    // Ya persistido: no se vuelve a guardar.
    expect(onRotated).toHaveBeenCalledTimes(2);
  });

  it('si el reintento de persistencia también falla, sigue abortando', async () => {
    const onRotated = vi.fn(() => Promise.reject(new Error('down')));
    const { provider } = make(
      [
        token({ access_token: 'A', expires_in: 3600, refresh_token: 'NEW-REFRESH' }),
        token({ access_token: 'B', expires_in: 3600 }),
      ],
      onRotated,
    );
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      failure: 'rotation_not_persisted',
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      failure: 'rotation_not_persisted',
    });
    expect(onRotated).toHaveBeenCalledTimes(2);
  });
});
