import { describe, expect, it, vi } from 'vitest';
import { HttpError, requestJson, type HttpPolicy } from '../../src/shared/resilient-fetch.ts';

const policy: HttpPolicy = {
  timeoutMs: 1_000,
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxRetryAfterMs: 5_000,
};

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function run(responses: (Response | Error)[], overrides: Partial<HttpPolicy> = {}) {
  const queue = [...responses];
  const fetchMock = vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const sleep = vi.fn(() => Promise.resolve());
  const call = () =>
    requestJson(
      'GET /v1/things',
      'https://api.example/v1/things?q=secret-title',
      { method: 'GET' },
      { ...policy, ...overrides },
      { fetch: fetchMock as unknown as typeof fetch, sleep, random: () => 0.5 },
    );
  return { call, fetchMock, sleep };
}

describe('requestJson', () => {
  it('devuelve el JSON de una respuesta correcta', async () => {
    const { call, fetchMock } = run([reply(200, { ok: true })]);
    await expect(call()).resolves.toEqual({ status: 200, json: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('acepta un cuerpo vacío (201 sin contenido)', async () => {
    const { call } = run([reply(201, '')]);
    await expect(call()).resolves.toEqual({ status: 201, json: undefined });
  });

  it('reintenta 5xx con backoff exponencial y termina bien', async () => {
    const { call, sleep, fetchMock } = run([reply(503), reply(502), reply(200, { n: 1 })]);
    await expect(call()).resolves.toMatchObject({ json: { n: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // random=0.5 → factor 0.75: 100*0.75 y 200*0.75
    expect(sleep.mock.calls.map((call) => (call as unknown as [number])[0])).toEqual([75, 150]);
  });

  it('agota los reintentos y lanza el último error', async () => {
    const { call, fetchMock } = run([reply(500), reply(500), reply(500)]);
    await expect(call()).rejects.toMatchObject({ kind: 'server-error', status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('respeta Retry-After en un 429', async () => {
    const { call, sleep } = run([reply(429, {}, { 'retry-after': '3' }), reply(200)]);
    await call();
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it('no espera un Retry-After mayor al máximo: corta y lo informa', async () => {
    const { call, sleep, fetchMock } = run([reply(429, {}, { 'retry-after': '3600' })]);
    await expect(call()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 3_600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('no reintenta cuota agotada', async () => {
    const { call, fetchMock } = run([reply(429, { reason: 'QUOTA_EXCEEDED' })]);
    await expect(call()).rejects.toMatchObject({ kind: 'quota-exceeded' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no reintenta errores 4xx', async () => {
    const { call, fetchMock } = run([reply(404, { error: 'nope' })]);
    await expect(call()).rejects.toMatchObject({ kind: 'client-error', status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reintenta errores de red y timeouts', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { call, fetchMock } = run([new TypeError('fetch failed'), timeout, reply(200, {})]);
    await expect(call()).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clasifica un timeout final como timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { call } = run([timeout], { maxRetries: 0 });
    await expect(call()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('una respuesta correcta con JSON inválido falla sin reintentar', async () => {
    const { call, fetchMock } = run([reply(200, '{not json')]);
    await expect(call()).rejects.toMatchObject({ kind: 'invalid-json' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('en escrituras no idempotentes solo reintenta el 429', async () => {
    const write = run([reply(503), reply(200)], { retryAmbiguousFailures: false });
    await expect(write.call()).rejects.toMatchObject({ kind: 'server-error' });
    expect(write.fetchMock).toHaveBeenCalledTimes(1);

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const network = run([timeout, reply(200)], { retryAmbiguousFailures: false });
    await expect(network.call()).rejects.toMatchObject({ kind: 'timeout' });

    const limited = run([reply(429, {}, { 'retry-after': '1' }), reply(200)], {
      retryAmbiguousFailures: false,
    });
    await expect(limited.call()).resolves.toMatchObject({ status: 200 });
  });

  it('beforeAttempt corre antes de cada intento y con la espera antes de dormir', async () => {
    const events: string[] = [];
    let sent = 0;
    const fetchMock = vi.fn(() => {
      events.push('fetch');
      sent += 1;
      return Promise.resolve(reply(sent === 1 ? 429 : 200, {}, { 'retry-after': '3' }));
    });
    const sleep = vi.fn(() => {
      events.push('sleep');
      return Promise.resolve();
    });
    await requestJson(
      'POST /v1/things',
      'https://api.example/v1/things',
      { method: 'POST' },
      policy,
      {
        fetch: fetchMock as unknown as typeof fetch,
        sleep,
        random: () => 0.5,
        beforeAttempt: (startsInMs) => events.push(`guard:${startsInMs}`),
      },
    );
    expect(events).toEqual(['guard:0', 'fetch', 'guard:3000', 'sleep', 'guard:0', 'fetch']);
  });

  it('si beforeAttempt lanza ante un reintento no duerme ni vuelve a enviar', async () => {
    const stop = new Error('budget');
    const fetchMock = vi.fn(() => Promise.resolve(reply(429, {}, { 'retry-after': '3' })));
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      requestJson('POST /v1/things', 'https://api.example/v1/things', { method: 'POST' }, policy, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep,
        beforeAttempt: (startsInMs) => {
          if (startsInMs > 0) throw stop;
        },
      }),
    ).rejects.toBe(stop);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('todo 5xx es server-error, pero solo 500/502/503/504 se reintentan', async () => {
    const odd = run([reply(507), reply(200)]);
    await expect(odd.call()).rejects.toMatchObject({ kind: 'server-error', status: 507 });
    expect(odd.fetchMock).toHaveBeenCalledTimes(1);

    const retried = run([reply(502), reply(200)]);
    await expect(retried.call()).resolves.toMatchObject({ status: 200 });
  });

  it('el mensaje de error no incluye la query ni el cuerpo', async () => {
    const { call } = run([reply(404, { detail: 'secret-title' })]);
    const error = (await call().catch((e: unknown) => e)) as HttpError;
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).not.toContain('secret-title');
    expect(error.message).toContain('GET /v1/things');
  });
});
