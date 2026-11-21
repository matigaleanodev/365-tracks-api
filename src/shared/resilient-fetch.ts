export interface HttpPolicy {
  /** Tiempo máximo de cada intento. */
  timeoutMs: number;
  /** Reintentos después del primer intento (0 = sin reintentos). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Un `Retry-After` mayor no se espera dentro de una Lambda: se informa y se corta. */
  maxRetryAfterMs: number;
  /**
   * false para escrituras no idempotentes: un timeout, un corte de red o un 5xx pueden haber
   * sido procesados igual, así que solo se reintenta un 429 (el servicio no hizo nada).
   */
  retryAmbiguousFailures?: boolean;
}

export const DEFAULT_HTTP_POLICY: HttpPolicy = {
  timeoutMs: 10_000,
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 15_000,
};

export interface HttpDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Devuelve un número en [0, 1); se inyecta para tests deterministas. */
  random?: () => number;
  /**
   * Se llama justo antes de cada intento real con 0, y antes de dormir para un reintento con la
   * espera calculada. Si lanza, la llamada se aborta sin enviar ni esperar más: sirve para
   * imponer un presupuesto de tiempo a las escrituras.
   */
  beforeAttempt?: (startsInMs: number) => void;
}

export interface JsonResponse {
  status: number;
  /** `undefined` si el cuerpo está vacío (por ejemplo 201 sin contenido). */
  json: unknown;
}

export type HttpFailureKind =
  | 'client-error'
  | 'server-error'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'timeout'
  | 'network'
  | 'invalid-json';

/**
 * Error de una llamada HTTP. El mensaje lleva método, ruta y estado, nunca la query ni
 * encabezados: puede terminar en logs y las consultas incluyen títulos de canciones.
 */
export class HttpError extends Error {
  readonly kind: HttpFailureKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** Cuerpo de error ya acotado; los servicios de este proyecto no devuelven secretos en él. */
  readonly body: string;

  constructor(
    kind: HttpFailureKind,
    description: string,
    options: { status?: number; retryAfterMs?: number; body?: string } = {},
  ) {
    super(`${description} failed: ${kind}${options.status ? ` (HTTP ${options.status})` : ''}`);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body ?? '';
  }
}

const MAX_BODY_CHARS = 300;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Retry-After` en segundos (la forma que usan Spotify y OpenAI). */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isQuotaExceeded(text: string): boolean {
  const parsed = parseJson(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return false;
  const body = parsed.value as Record<string, unknown>;
  // Spotify distingue cuota (no se recupera esperando segundos) de rate limit.
  return body.reason === 'QUOTA_EXCEEDED';
}

/**
 * Llamada JSON con timeout por intento, reintentos acotados y backoff exponencial con jitter.
 * Reintenta errores de red, timeouts, 5xx y 429 de rate limit (respetando `Retry-After`).
 * No reintenta 4xx, cuota agotada ni un `Retry-After` mayor al máximo configurado.
 */
export async function requestJson(
  description: string,
  url: string,
  init: RequestInit,
  policy: HttpPolicy = DEFAULT_HTTP_POLICY,
  {
    fetch: fetchImpl = fetch,
    sleep = defaultSleep,
    random = Math.random,
    beforeAttempt,
  }: HttpDependencies = {},
): Promise<JsonResponse> {
  for (let attempt = 0; ; attempt += 1) {
    // Fuera del try: lo que lance el guard no es un fallo HTTP reintentable.
    beforeAttempt?.(0);
    const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
    const jittered = Math.round(backoff * (0.5 + random() / 2));
    let failure: HttpError;

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      const text = await response.text();

      if (response.ok) {
        const parsed = parseJson(text);
        if (!parsed.ok) {
          throw new HttpError('invalid-json', description, { status: response.status });
        }
        return { status: response.status, json: parsed.value };
      }

      const body = text.slice(0, MAX_BODY_CHARS);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      if (response.status === 429) {
        if (isQuotaExceeded(text)) {
          throw new HttpError('quota-exceeded', description, { status: 429, body });
        }
        if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
          throw new HttpError('rate-limited', description, { status: 429, retryAfterMs, body });
        }
        failure = new HttpError('rate-limited', description, {
          status: 429,
          body,
          ...(retryAfterMs !== undefined && { retryAfterMs }),
        });
      } else if (response.status >= 500) {
        // Todo 5xx es un fallo del servidor (y ambiguo en un POST); cuáles se reintentan se decide abajo.
        failure = new HttpError('server-error', description, { status: response.status, body });
      } else {
        throw new HttpError('client-error', description, { status: response.status, body });
      }
    } catch (error) {
      // Los errores definitivos se lanzan dentro del try; los reintentables solo se asignan.
      if (error instanceof HttpError) {
        throw error;
      }
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      failure = new HttpError(timedOut ? 'timeout' : 'network', description);
    }

    if (attempt >= policy.maxRetries) {
      throw failure;
    }
    // Un 5xx fuera de la lista (501, 507, 511…) no mejora esperando.
    if (
      failure.status !== undefined &&
      failure.status >= 500 &&
      !RETRYABLE_STATUS.has(failure.status)
    ) {
      throw failure;
    }
    if (policy.retryAmbiguousFailures === false && failure.kind !== 'rate-limited') {
      throw failure;
    }
    const delayMs = Math.max(jittered, failure.retryAfterMs ?? 0);
    // Si esperar agota el presupuesto, se aborta ahora: sin dormir ni reenviar.
    beforeAttempt?.(delayMs);
    await sleep(delayMs);
  }
}
