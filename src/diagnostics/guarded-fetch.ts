import { HttpError } from '../shared/resilient-fetch.ts';

/** Registro de una petición: nunca lleva query, encabezados ni cuerpo. */
export interface RequestRecord {
  method: string;
  host: string;
  path: string;
}

export interface GuardedFetch {
  fetch: typeof fetch;
  /** Peticiones que se dejaron pasar al fetch real (o simulado). */
  readonly requests: readonly RequestRecord[];
  /** Peticiones bloqueadas antes de salir. */
  readonly blocked: readonly RequestRecord[];
}

/**
 * Lo único que el preview puede pedir: método y ruta por host. Todo lo demás (otros hosts,
 * escrituras de playlists, cualquier POST/PUT/DELETE fuera de estos) se bloquea sin enviar nada.
 */
const ALLOWED: Readonly<Record<string, { method: string; path: RegExp }[]>> = {
  'api.openai.com': [{ method: 'POST', path: /^\/v1\/responses$/ }],
  'accounts.spotify.com': [{ method: 'POST', path: /^\/api\/token$/ }],
  'api.spotify.com': [
    { method: 'GET', path: /^\/v1\/search$/ },
    { method: 'GET', path: /^\/v1\/tracks\/[A-Za-z0-9]{22}$/ },
  ],
};

export const ALLOWED_HOSTS: readonly string[] = Object.keys(ALLOWED);

/**
 * Envuelve un fetch para imponer la lista de destinos del preview. Lanza `HttpError` de tipo
 * `client-error` (no reintentable) cuando bloquea, así la causa llega al informe sin reintentos.
 */
export function createGuardedFetch(inner: typeof fetch): GuardedFetch {
  const requests: RequestRecord[] = [];
  const blocked: RequestRecord[] = [];

  const guarded: typeof fetch = (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      // URL inválida: se bloquea abajo.
    }
    const record: RequestRecord = {
      method,
      host: url?.host ?? 'invalid-url',
      path: url?.pathname ?? '',
    };
    const rules = url !== null && url.protocol === 'https:' ? ALLOWED[url.host] : undefined;
    const allowed = rules?.some((rule) => rule.method === method && rule.path.test(record.path));
    if (!allowed) {
      blocked.push(record);
      return Promise.reject(
        new HttpError('client-error', `Blocked request ${method} ${record.host}${record.path}`),
      );
    }
    requests.push(record);
    return inner(input, init);
  };

  return { fetch: guarded, requests, blocked };
}
