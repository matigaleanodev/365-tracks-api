import { GetParametersCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import {
  MissingParameterError,
  PARAMETER_KEYS,
  parameterName,
  readParameters,
  SsmParameterStore,
  type ParameterStore,
} from '../../src/config/parameters.ts';

const storeOf = (values: Record<string, string>): ParameterStore => ({
  getMany: (names) =>
    Promise.resolve(new Map(names.flatMap((n) => (n in values ? [[n, values[n] as string]] : [])))),
  put: () => Promise.resolve(),
});

describe('readParameters', () => {
  it('arma los nombres con el prefijo, sin barras repetidas', () => {
    expect(parameterName('/tracks365/', PARAMETER_KEYS.openaiApiKey)).toBe(
      '/tracks365/openai/api-key',
    );
  });

  it('exige los obligatorios y permite los opcionales', async () => {
    const reader = await readParameters(
      storeOf({ '/tracks365/openai/api-key': ' sk-secret ' }),
      '/tracks365',
      [PARAMETER_KEYS.openaiApiKey, PARAMETER_KEYS.criteriaWeights],
    );
    expect(reader.require(PARAMETER_KEYS.openaiApiKey)).toBe('sk-secret');
    expect(reader.optional(PARAMETER_KEYS.criteriaWeights)).toBeUndefined();
  });

  it('un parámetro faltante o vacío falla nombrando la clave, nunca un valor', async () => {
    const reader = await readParameters(
      storeOf({ '/tracks365/openai/model': '  ' }),
      '/tracks365',
      [PARAMETER_KEYS.openaiModel],
    );
    const error = (() => {
      try {
        reader.require(PARAMETER_KEYS.openaiModel);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(MissingParameterError);
    expect(error?.message).toContain('/tracks365/openai/model');
  });
});

describe('SsmParameterStore', () => {
  it('lee con descifrado y en lotes de 10', async () => {
    const send = vi.fn((command: GetParametersCommand) =>
      Promise.resolve({
        Parameters: (command.input.Names ?? []).map((Name) => ({ Name, Value: `v:${Name}` })),
      }),
    );
    const store = new SsmParameterStore({ send } as unknown as SSMClient);
    const names = Array.from({ length: 12 }, (_, i) => `/p/${i}`);

    const result = await store.getMany(names);

    expect(result.size).toBe(12);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as GetParametersCommand;
    expect(first).toBeInstanceOf(GetParametersCommand);
    expect(first.input.WithDecryption).toBe(true);
    expect(first.input.Names).toHaveLength(10);
  });

  it('escribe SecureString con sobrescritura (rotación del refresh token)', async () => {
    const send = vi.fn(() => Promise.resolve({}));
    await new SsmParameterStore({ send } as unknown as SSMClient).put('/p/refresh', 'R2');
    const command = send.mock.calls[0] as unknown as [PutParameterCommand];
    expect(command[0]).toBeInstanceOf(PutParameterCommand);
    expect(command[0].input).toMatchObject({ Type: 'SecureString', Overwrite: true });
  });
});
