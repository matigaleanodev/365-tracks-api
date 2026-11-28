import { createHash } from 'node:crypto';
import { PARAMETER_KEYS, parameterName, type ParameterStore } from './parameters.ts';

/**
 * Sincroniza las credenciales de Spotify desde su fuente (GitHub Secrets) hacia Parameter Store, que
 * sigue siendo la fuente operativa que lee el backend.
 *
 * El refresh token es especial: Spotify puede devolver uno nuevo al renovar el access token y la
 * Lambda de la playlist lo guarda en Parameter Store. Para que una sincronización posterior no
 * restaure el valor viejo de GitHub, se guarda junto al token el SHA-256 del último valor sembrado
 * desde la fuente. Si el secreto de GitHub no cambió desde la última siembra, el token de Parameter
 * Store se respeta aunque sea distinto (Spotify lo rotó). Si cambió (una reautorización), se siembra.
 */
export interface SpotifySecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type RawSecrets = Partial<Record<keyof SpotifySecrets, string | undefined>>;

/** Nombres de los secretos de GitHub (entorno `secrets`). */
export const GITHUB_SECRET_NAMES = {
  clientId: 'SPOTIFY_CLIENT_ID',
  clientSecret: 'SPOTIFY_CLIENT_SECRET',
  refreshToken: 'SPOTIFY_REFRESH_TOKEN',
} as const satisfies Record<keyof SpotifySecrets, string>;

export type SyncAction = 'created' | 'updated' | 'unchanged' | 'kept-rotated';

/** Nombre del parámetro y acción. Nunca lleva valores. */
export type SyncResult = { name: string; action: SyncAction };

/** Falta algún secreto: no se escribe nada. El mensaje lleva nombres, nunca valores. */
export class MissingSecretsError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Missing or empty secrets: ${missing.join(', ')}. Nothing was written.`);
    this.name = 'MissingSecretsError';
    this.missing = missing;
  }
}

export const seedFingerprint = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const spotifyParameterNames = (prefix: string) => ({
  clientId: parameterName(prefix, PARAMETER_KEYS.spotifyClientId),
  clientSecret: parameterName(prefix, PARAMETER_KEYS.spotifyClientSecret),
  refreshToken: parameterName(prefix, PARAMETER_KEYS.spotifyRefreshToken),
  refreshTokenSeed: parameterName(prefix, PARAMETER_KEYS.spotifyRefreshTokenSeed),
});

/** Recorta y valida todo antes de tocar Parameter Store. */
export function validateSecrets(raw: RawSecrets): SpotifySecrets {
  const value = (key: keyof SpotifySecrets) => raw[key]?.trim() ?? '';
  const keys = Object.keys(GITHUB_SECRET_NAMES) as (keyof SpotifySecrets)[];
  const missing = keys.filter((key) => value(key) === '').map((key) => GITHUB_SECRET_NAMES[key]);
  if (missing.length > 0) throw new MissingSecretsError(missing);
  return {
    clientId: value('clientId'),
    clientSecret: value('clientSecret'),
    refreshToken: value('refreshToken'),
  };
}

/** Idempotente: solo escribe lo que difiere. Nunca escribe valores vacíos. */
export interface SyncOptions {
  /**
   * Valores anteriores del refresh token en Parameter Store (historial de versiones). Si el valor de
   * la fuente ya estuvo guardado, no es una autorización nueva sino una vieja: solo se corrige la
   * huella y se conserva el token vigente. Cubre una huella que no se llegó a escribir y un token
   * guardado a mano o con `--store` sin actualizar GitHub.
   */
  tokenHistory?: (name: string) => Promise<readonly string[]>;
}

/** Idempotente: solo escribe lo que difiere. Nunca escribe valores vacíos. */
export async function syncSpotifySecrets(
  store: ParameterStore,
  prefix: string,
  raw: RawSecrets,
  { tokenHistory }: SyncOptions = {},
): Promise<SyncResult[]> {
  const secrets = validateSecrets(raw);
  const names = spotifyParameterNames(prefix);
  const current = await store.getMany(Object.values(names));
  const results: SyncResult[] = [];

  // Primero el secret: si falla la segunda escritura, el par sigue siendo el viejo completo o el
  // nuevo secret con el id de siempre (una rotación de secret no cambia el id).
  for (const key of ['clientSecret', 'clientId'] as const) {
    const existing = current.get(names[key]);
    if (existing === secrets[key]) {
      results.push({ name: names[key], action: 'unchanged' });
      continue;
    }
    await store.put(names[key], secrets[key]);
    results.push({ name: names[key], action: existing === undefined ? 'created' : 'updated' });
  }

  const fingerprint = seedFingerprint(secrets.refreshToken);
  const existingToken = current.get(names.refreshToken);
  const existingSeed = current.get(names.refreshTokenSeed);
  const token = names.refreshToken;
  if (existingToken !== undefined && existingSeed === fingerprint) {
    // Misma siembra que la última vez: si Spotify rotó el token, el de Parameter Store es el vigente.
    results.push({
      name: token,
      action: existingToken === secrets.refreshToken ? 'unchanged' : 'kept-rotated',
    });
    return results;
  }
  if (existingToken === secrets.refreshToken) {
    if (existingSeed !== fingerprint) await store.put(names.refreshTokenSeed, fingerprint);
    results.push({ name: token, action: 'unchanged' });
    return results;
  }
  if (existingToken !== undefined && tokenHistory) {
    const previous = await tokenHistory(token);
    if (previous.includes(secrets.refreshToken)) {
      // El valor de la fuente ya fue sembrado y después reemplazado (rotación o reautorización):
      // restaurarlo podría invalidar la autorización.
      await store.put(names.refreshTokenSeed, fingerprint);
      results.push({ name: token, action: 'kept-rotated' });
      return results;
    }
  }
  // Autorización nueva en la fuente (o primera siembra): primero el token, después la huella.
  await store.put(token, secrets.refreshToken);
  await store.put(names.refreshTokenSeed, fingerprint);
  results.push({ name: token, action: existingToken === undefined ? 'created' : 'updated' });
  return results;
}

/**
 * Guarda el refresh token que Spotify devolvió al renovar, salvo que el parámetro ya no tenga el
 * token del que partió esta instancia: entonces otro proceso (una sincronización o una
 * reautorización) lo reemplazó y pisarlo restauraría una autorización vieja. Devuelve false en ese
 * caso; un fallo al escribir se propaga. Pensado para `onRefreshTokenRotated` de una instancia que
 * puede seguir caliente. Parameter Store no admite escrituras condicionales: queda una ventana
 * mínima entre la lectura y la escritura, por eso no se sincroniza mientras corre la playlist.
 */
export function createRotationPersister(store: ParameterStore, name: string, initial: string) {
  let known = initial;
  // Valor escrito sin confirmación (falló la escritura y también la relectura): si el parámetro
  // lo tiene después, lo escribió esta instancia y no es un reemplazo ajeno.
  let unconfirmed: string | undefined;
  return async (rotated: string): Promise<boolean> => {
    const read = async () => (await store.getMany([name])).get(name)?.trim();
    const current = await read();
    if (current !== undefined && current !== known && current !== unconfirmed) return false;
    // El parámetro conserva el valor propio sin confirmar: queda confirmado antes de otro intento,
    // así un fallo posterior no lo pierde.
    if (current !== undefined && current === unconfirmed) {
      known = current;
      unconfirmed = undefined;
    }
    try {
      await store.put(name, rotated);
    } catch (error) {
      // La escritura pudo haberse aplicado igual: se relee para no confundirla después con un
      // reemplazo ajeno. El error se propaga: la rotación no quedó confirmada.
      try {
        if ((await read()) === rotated) known = rotated;
        unconfirmed = undefined;
      } catch {
        unconfirmed = rotated;
      }
      throw error;
    }
    known = rotated;
    unconfirmed = undefined;
    return true;
  };
}
