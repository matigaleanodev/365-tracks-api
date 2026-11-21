import { GetParametersCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';

/** Nombres relativos al prefijo del despliegue (`SSM_PARAMETER_PREFIX`, p. ej. `/tracks365`). */
export const PARAMETER_KEYS = {
  spotifyClientId: 'spotify/client-id',
  spotifyClientSecret: 'spotify/client-secret',
  spotifyRefreshToken: 'spotify/refresh-token',
  openaiApiKey: 'openai/api-key',
  openaiModel: 'openai/model',
  criteriaWeights: 'selection/criteria-weights',
} as const;

export type ParameterKey = (typeof PARAMETER_KEYS)[keyof typeof PARAMETER_KEYS];

export interface ParameterStore {
  /** Solo devuelve los que existen. Los valores son secretos: no se registran. */
  getMany(names: readonly string[]): Promise<Map<string, string>>;
  put(name: string, value: string): Promise<void>;
}

/** Falta un parámetro obligatorio. El mensaje lleva el nombre, nunca un valor. */
export class MissingParameterError extends Error {
  constructor(name: string) {
    super(`Required parameter ${name} is not configured`);
    this.name = 'MissingParameterError';
  }
}

export const parameterName = (prefix: string, key: ParameterKey) =>
  `${prefix.replace(/\/+$/, '')}/${key}`;

const GET_PARAMETERS_BATCH = 10;

export class SsmParameterStore implements ParameterStore {
  readonly #client: SSMClient;

  constructor(client: SSMClient) {
    this.#client = client;
  }

  async getMany(names: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let start = 0; start < names.length; start += GET_PARAMETERS_BATCH) {
      const { Parameters = [] } = await this.#client.send(
        new GetParametersCommand({
          Names: names.slice(start, start + GET_PARAMETERS_BATCH),
          WithDecryption: true,
        }),
      );
      for (const { Name, Value } of Parameters) {
        if (Name !== undefined && Value !== undefined) found.set(Name, Value);
      }
    }
    return found;
  }

  async put(name: string, value: string): Promise<void> {
    await this.#client.send(
      new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }),
    );
  }
}

export interface ParameterReader {
  require(key: ParameterKey): string;
  optional(key: ParameterKey): string | undefined;
}

/** Lee de una vez los parámetros que necesita una función y exige los obligatorios. */
export async function readParameters(
  store: ParameterStore,
  prefix: string,
  keys: readonly ParameterKey[],
): Promise<ParameterReader> {
  const names = keys.map((key) => parameterName(prefix, key));
  const values = await store.getMany(names);
  const read = (key: ParameterKey) => {
    const value = values.get(parameterName(prefix, key))?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  return {
    optional: read,
    require(key) {
      const value = read(key);
      if (value === undefined) throw new MissingParameterError(parameterName(prefix, key));
      return value;
    },
  };
}
