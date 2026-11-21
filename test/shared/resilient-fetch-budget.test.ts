import { describe, expect, it, vi } from 'vitest';
import { HttpError, requestJson, type HttpPolicy } from '../../src/shared/resilient-fetch.ts';
import { createTimeBudget, TimeBudgetExhaustedError } from '../../src/shared/time-budget.ts';

const policy: HttpPolicy = {
  timeoutMs: 10_000,
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 15_000,
};

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(responses: (Response | Error)[], deadlineMs: number, reserveMs = 0) {
  let clock = 0;
  const queue = [...responses];
  const fetchMock = vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected extra request'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  };
  const budget = createTimeBudget({ deadlineMs, reserveMs, now: () => clock });
  const call = (withBudget = true) =>
    requestJson(
      'Spotify search',
      'https://api.example/v1/search?q=secret-title',
      { method: 'GET' },
      policy,
      {
        fetch: fetchMock as unknown as typeof fetch,
        sleep,
        random: () => 0.5,
        ...(withBudget && { budget }),
      },
    );
  return { call, fetchMock, sleeps, advance: (ms: number) => (clock += ms) };
}

describe('requestJson con presupuesto de tiempo', () => {
  it('sin presupuesto el comportamiento no cambia', async () => {
    const { call, fetchMock, sleeps } = setup([reply(503), reply(200, { ok: 1 })], 0);
    // El presupuesto (ya vencido) existe pero no se pasa.
    await expect(call(false)).resolves.toMatchObject({ json: { ok: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([375]);
  });

  it('no envía nada si el timeout del intento no entra', async () => {
    const { call, fetchMock, sleeps } = setup([reply(200)], 9_999);
    await expect(call()).rejects.toBeInstanceOf(TimeBudgetExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it('la reserva también cuenta para empezar un intento', async () => {
    const { call, fetchMock } = setup([reply(200)], 25_000, 20_000);
    await expect(call()).rejects.toBeInstanceOf(TimeBudgetExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con tiempo suficiente funciona igual que sin presupuesto', async () => {
    const { call, fetchMock } = setup([reply(200, { a: 1 })], 10_000);
    await expect(call()).resolves.toEqual({ status: 200, json: { a: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('antes de dormir exige que entren la espera y el siguiente intento', async () => {
    // backoff 500*0.75 = 375; 375 + 10_000 > 10_374 → corta sin dormir.
    const { call, fetchMock, sleeps } = setup([reply(503), reply(200)], 10_374);
    await expect(call()).rejects.toBeInstanceOf(TimeBudgetExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('si la espera y el intento entran justo, reintenta', async () => {
    const { call, fetchMock, sleeps } = setup([reply(503), reply(200, { ok: 1 })], 10_375);
    await expect(call()).resolves.toMatchObject({ json: { ok: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([375]);
  });

  it('respeta Retry-After mientras entra y corta sin dormir cuando ya no entra', async () => {
    const limited = () => reply(429, {}, { 'retry-after': '5' });
    const { call, fetchMock, sleeps } = setup([limited(), limited(), limited(), limited()], 20_000);
    await expect(call()).rejects.toBeInstanceOf(TimeBudgetExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('un Retry-After mayor al máximo sigue siendo rate-limited, no presupuesto', async () => {
    const { call, fetchMock } = setup([reply(429, {}, { 'retry-after': '60' })], 1_000_000);
    await expect(call()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('QUOTA_EXCEEDED sigue siendo quota-exceeded', async () => {
    const { call } = setup([reply(429, { reason: 'QUOTA_EXCEEDED' })], 1_000_000);
    const error: unknown = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ kind: 'quota-exceeded' });
  });

  it.each([
    ['error.code', { error: { code: 'insufficient_quota', message: 'x' } }],
    ['error.type', { error: { type: 'insufficient_quota', message: 'x' } }],
  ])(
    'la cuota de OpenAI (%s) es quota-exceeded: sin reintento ni sleep, con o sin budget',
    async (_n, body) => {
      for (const withBudget of [true, false]) {
        const { call, fetchMock, sleeps } = setup(
          [reply(429, body, { 'retry-after': '5' })],
          10_000,
        );
        await expect(call(withBudget)).rejects.toMatchObject({
          kind: 'quota-exceeded',
          status: 429,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
      }
    },
  );

  it('un 429 de OpenAI que no es de cuota sigue siendo reintentable', async () => {
    const { call, fetchMock } = setup(
      [reply(429, { error: { code: 'rate_limit_exceeded' } }), reply(200, { ok: 1 })],
      100_000,
    );
    await expect(call()).resolves.toMatchObject({ json: { ok: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('el presupuesto vencido no se convierte en un fallo HTTP reintentable', async () => {
    const { call, fetchMock, advance } = setup([reply(200)], 5_000);
    advance(6_000);
    await expect(call()).rejects.toMatchObject({ name: 'TimeBudgetExhaustedError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el mensaje del error no incluye la query', async () => {
    const { call } = setup([reply(200)], 0);
    await expect(call()).rejects.toThrow(/^Time budget exhausted before Spotify search/);
    await expect(call()).rejects.not.toThrow(/secret-title/);
  });

  it('beforeAttempt sigue funcionando junto al presupuesto', async () => {
    const beforeAttempt = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(reply(200, { ok: 1 })));
    const budget = createTimeBudget({ deadlineMs: 100_000, reserveMs: 0, now: () => 0 });
    await requestJson('x', 'https://api.example/x', {}, policy, {
      fetch: fetchMock as unknown as typeof fetch,
      beforeAttempt,
      budget,
    });
    expect(beforeAttempt).toHaveBeenCalledWith(0);
  });
});
