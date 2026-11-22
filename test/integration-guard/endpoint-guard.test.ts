import { describe, expect, it } from 'vitest';
import {
  assertSanitizedEnv,
  buildSanitizedEnv,
  parseLocalEndpoint,
  RUN_ID_VAR,
  VALIDATED_ENDPOINT_VAR,
} from '../../test-integration/support/guard.ts';

describe('guarda del endpoint de integración', () => {
  it.each([
    ['http://localhost:8000', 'http://localhost:8000'],
    ['http://127.0.0.1:18000', 'http://127.0.0.1:18000'],
    ['http://[::1]:8000', 'http://[::1]:8000'],
    ['http://127.0.0.1:18000/', 'http://127.0.0.1:18000'],
  ])('acepta %s', (raw, normalized) => {
    expect(parseLocalEndpoint(raw)).toBe(normalized);
  });

  it.each([
    undefined,
    '',
    'https://localhost:8000',
    'http://localhost',
    'http://localhost:0',
    'http://localhost:65536',
    'http://dynamodb.us-east-1.amazonaws.com',
    'http://dynamodb.us-east-1.amazonaws.com:8000',
    'http://localhost.amazonaws.com:8000',
    'http://example.com:8000',
    'http://10.0.0.5:8000',
    'http://127.0.0.2:8000',
    'http://192.168.1.10:8000',
    'http://0.0.0.0:8000',
    'http://user:pass@localhost:8000',
    'http://localhost:8000@evil.com:80',
    'http://evil.com:80#@localhost:8000',
    'http://localhost:8000/path',
    'http://localhost:8000//',
    'http://localhost:8000?x=1',
    'http://localhost:8000#frag',
    'http://LOCALHOST:8000',
    ' http://localhost:8000',
    'http://localhost:8000 ',
    'ftp://localhost:8000',
  ])('rechaza %j', (raw) => {
    expect(() => parseLocalEndpoint(raw)).toThrow(/Refusing endpoint|unexpected URL/);
  });
});

describe('entorno saneado de integración', () => {
  const inherited = {
    PATH: '/usr/bin',
    AWS_PROFILE: 'produccion',
    AWS_ACCESS_KEY_ID: 'AKIAREAL',
    AWS_SECRET_ACCESS_KEY: 'real',
    AWS_SESSION_TOKEN: 'token',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: 'https://dynamodb.us-east-1.amazonaws.com',
    AWS_ENDPOINT_URL_DYNAMODB: 'https://dynamodb.us-east-1.amazonaws.com',
    AWS_CONFIG_FILE: '/home/x/.aws/config',
    AWS_SHARED_CREDENTIALS_FILE: '/home/x/.aws/credentials',
    DYNAMODB_LOCAL_ENDPOINT: 'http://localhost:1',
  };

  it('elimina todo lo heredado de AWS y fija valores ficticios', () => {
    const env = buildSanitizedEnv(inherited, 'http://127.0.0.1:18000', 'abc123def');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL_DYNAMODB).toBeUndefined();
    expect(env.DYNAMODB_LOCAL_ENDPOINT).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).not.toBe('AKIAREAL');
    expect(env.AWS_CONFIG_FILE).toBe('/dev/null');
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(env[VALIDATED_ENDPOINT_VAR]).toBe('http://127.0.0.1:18000');
    expect(env[RUN_ID_VAR]).toBe('abc123def');
    expect(() => assertSanitizedEnv(env)).not.toThrow();
  });

  it('no construye el entorno con un endpoint no local', () => {
    expect(() =>
      buildSanitizedEnv(inherited, 'https://dynamodb.us-east-1.amazonaws.com', 'abc123def'),
    ).toThrow();
  });

  it('la suite rechaza un entorno sin sanear', () => {
    expect(() => assertSanitizedEnv(inherited)).toThrow();
    const env = buildSanitizedEnv(inherited, 'http://127.0.0.1:18000', 'abc123def');
    expect(() => assertSanitizedEnv({ ...env, AWS_PROFILE: 'produccion' })).toThrow(/unexpected/);
    expect(() => assertSanitizedEnv({ ...env, AWS_ACCESS_KEY_ID: 'AKIAREAL' })).toThrow(
      /sanitized/,
    );
    expect(() => assertSanitizedEnv({ ...env, [RUN_ID_VAR]: undefined })).toThrow(/invalid/);
    expect(() =>
      assertSanitizedEnv({ ...env, [VALIDATED_ENDPOINT_VAR]: 'https://example.com:443' }),
    ).toThrow(/Refusing/);
  });
});
