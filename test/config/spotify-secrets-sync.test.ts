import { describe, expect, it } from 'vitest';
import type { ParameterStore } from '../../src/config/parameters.ts';
import {
  createRotationPersister,
  MissingSecretsError,
  seedFingerprint,
  syncSpotifySecrets,
} from '../../src/config/spotify-secrets-sync.ts';

const PREFIX = '/tracks365';
const ID = `${PREFIX}/spotify/client-id`;
const SECRET = `${PREFIX}/spotify/client-secret`;
const TOKEN = `${PREFIX}/spotify/refresh-token`;
const SEED = `${PREFIX}/spotify/refresh-token-seed-sha256`;

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  const store: ParameterStore = {
    getMany: (names) =>
      Promise.resolve(new Map(names.flatMap((n) => (values.has(n) ? [[n, values.get(n)!]] : [])))),
    put: (name, value) => {
      writes.push(name);
      values.set(name, value);
      return Promise.resolve();
    },
  };
  return { store, values, writes };
}

const source = { clientId: 'id-1', clientSecret: 'secret-1', refreshToken: 'token-1' };

describe('syncSpotifySecrets', () => {
  it('la primera siembra crea los tres parámetros y la huella del refresh token', async () => {
    const { store, values } = memoryStore();
    const results = await syncSpotifySecrets(store, PREFIX, source);
    expect(results).toEqual([
      { name: SECRET, action: 'created' },
      { name: ID, action: 'created' },
      { name: TOKEN, action: 'created' },
    ]);
    expect(values.get(TOKEN)).toBe('token-1');
    expect(values.get(SEED)).toBe(seedFingerprint('token-1'));
    expect(values.get(SEED)).not.toContain('token-1');
  });

  it('es idempotente: una segunda corrida no escribe nada', async () => {
    const { store, writes } = memoryStore();
    await syncSpotifySecrets(store, PREFIX, source);
    writes.length = 0;
    const results = await syncSpotifySecrets(store, PREFIX, source);
    expect(writes).toEqual([]);
    expect(results.map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('respeta un refresh token que Spotify rotó: no restaura el valor viejo de GitHub', async () => {
    const { store, values, writes } = memoryStore();
    await syncSpotifySecrets(store, PREFIX, source);
    values.set(TOKEN, 'token-rotated-by-lambda');
    writes.length = 0;
    const results = await syncSpotifySecrets(store, PREFIX, source);
    expect(values.get(TOKEN)).toBe('token-rotated-by-lambda');
    expect(writes).toEqual([]);
    expect(results.at(-1)).toEqual({ name: TOKEN, action: 'kept-rotated' });
  });

  it('una reautorización (secreto nuevo en GitHub) reemplaza el token rotado', async () => {
    const { store, values } = memoryStore();
    await syncSpotifySecrets(store, PREFIX, source);
    values.set(TOKEN, 'token-rotated-by-lambda');
    const results = await syncSpotifySecrets(store, PREFIX, { ...source, refreshToken: 'token-2' });
    expect(values.get(TOKEN)).toBe('token-2');
    expect(values.get(SEED)).toBe(seedFingerprint('token-2'));
    expect(results.at(-1)).toEqual({ name: TOKEN, action: 'updated' });
  });

  it('rota el client secret sin tocar el resto', async () => {
    const { store, writes } = memoryStore();
    await syncSpotifySecrets(store, PREFIX, source);
    writes.length = 0;
    await syncSpotifySecrets(store, PREFIX, { ...source, clientSecret: 'secret-2' });
    expect(writes).toEqual([SECRET]);
  });

  it('sin huella previa (token guardado a mano) siembra el valor de la fuente', async () => {
    const { store, values } = memoryStore({ [TOKEN]: 'token-old' });
    await syncSpotifySecrets(store, PREFIX, source);
    expect(values.get(TOKEN)).toBe('token-1');
    expect(values.get(SEED)).toBe(seedFingerprint('token-1'));
  });

  it('no restaura un valor de la fuente que ya estuvo guardado (huella perdida o --store sin GitHub)', async () => {
    const { store, values } = memoryStore({
      [TOKEN]: 'token-3',
      [SEED]: seedFingerprint('token-2'),
    });
    const history = async () => ['token-1', 'token-2', 'token-3'];
    const results = await syncSpotifySecrets(store, PREFIX, source, { tokenHistory: history });
    expect(values.get(TOKEN)).toBe('token-3');
    expect(values.get(SEED)).toBe(seedFingerprint('token-1'));
    expect(results.at(-1)).toEqual({ name: TOKEN, action: 'kept-rotated' });
  });

  it('un valor que nunca estuvo guardado es una autorización nueva aunque haya historial', async () => {
    const { store, values } = memoryStore({
      [TOKEN]: 'token-3',
      [SEED]: seedFingerprint('token-2'),
    });
    await syncSpotifySecrets(
      store,
      PREFIX,
      { ...source, refreshToken: 'token-9' },
      {
        tokenHistory: async () => ['token-2', 'token-3'],
      },
    );
    expect(values.get(TOKEN)).toBe('token-9');
  });

  it('si falta o está vacío algún secreto no escribe nada y nombra solo los secretos', async () => {
    const { store, writes } = memoryStore({ [ID]: 'id-1' });
    const attempt = syncSpotifySecrets(store, PREFIX, { clientId: 'id-1', clientSecret: '  ' });
    await expect(attempt).rejects.toThrow(MissingSecretsError);
    await expect(attempt).rejects.toThrow(/SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN/);
    await expect(attempt).rejects.not.toThrow(/id-1/);
    expect(writes).toEqual([]);
  });

  it('recorta espacios y saltos de línea pegados con el secreto', async () => {
    const { store, values } = memoryStore();
    await syncSpotifySecrets(store, PREFIX, { ...source, refreshToken: ' token-1\n' });
    expect(values.get(TOKEN)).toBe('token-1');
  });
});

describe('createRotationPersister', () => {
  it('guarda cada rotación mientras el parámetro siga con el token conocido', async () => {
    const { store, values } = memoryStore({ [TOKEN]: 'token-1' });
    const persist = createRotationPersister(store, TOKEN, 'token-1');
    await expect(persist('token-2')).resolves.toBe(true);
    await expect(persist('token-3')).resolves.toBe(true);
    expect(values.get(TOKEN)).toBe('token-3');
  });

  it('compara sin espacios y, si la escritura falla, relee lo que quedó y propaga el error', async () => {
    const { store, values } = memoryStore({ [TOKEN]: ' token-1 ' });
    const persist = createRotationPersister(store, TOKEN, 'token-1');
    const put = store.put;
    store.put = async (name, value) => {
      await put(name, value);
      throw new Error('timeout');
    };
    await expect(persist('token-2')).rejects.toThrow('timeout');
    expect(values.get(TOKEN)).toBe('token-2');
    store.put = put;
    // La escritura sí se aplicó: la próxima rotación no la confunde con un reemplazo ajeno.
    await expect(persist('token-3')).resolves.toBe(true);
  });

  it('si la escritura y la relectura fallan, reconoce después su propio valor y no pierde la rotación', async () => {
    const { store, values } = memoryStore({ [TOKEN]: 'token-1' });
    const persist = createRotationPersister(store, TOKEN, 'token-1');
    const { put, getMany } = store;
    let failReads = false;
    store.put = async (name, value) => {
      await put(name, value);
      failReads = true;
      throw new Error('timeout');
    };
    store.getMany = (names) => (failReads ? Promise.reject(new Error('sin red')) : getMany(names));
    await expect(persist('token-2')).rejects.toThrow('timeout');
    expect(values.get(TOKEN)).toBe('token-2');
    store.put = put;
    failReads = false;
    // El parámetro tiene el valor que escribió esta instancia: la rotación siguiente se guarda.
    await expect(persist('token-3')).resolves.toBe(true);
    expect(values.get(TOKEN)).toBe('token-3');
  });

  it('una instancia caliente no pisa un token que otro proceso reemplazó', async () => {
    const { store, values, writes } = memoryStore({ [TOKEN]: 'token-1' });
    const persist = createRotationPersister(store, TOKEN, 'token-1');
    values.set(TOKEN, 'token-reauthorized');
    await expect(persist('token-2')).resolves.toBe(false);
    expect(values.get(TOKEN)).toBe('token-reauthorized');
    expect(writes).toEqual([]);
  });
});
