/**
 * Guarda de destino de las pruebas de integración: solo DynamoDB Local en loopback, con
 * credenciales y región ficticias. La usan el runner, la suite (globalSetup y clientes) y un test
 * unitario que corre en `npm test` sin Docker.
 */

/** Variable propia con el endpoint ya validado (la define el runner, nunca el usuario). */
export const VALIDATED_ENDPOINT_VAR = 'INTEGRATION_DYNAMODB_ENDPOINT';
/** Identificador de la corrida: prefijo de las tablas temporales. */
export const RUN_ID_VAR = 'INTEGRATION_RUN_ID';

export const DUMMY_ACCESS_KEY_ID = 'LOCALINTEGRATIONKEY';
export const DUMMY_SECRET_ACCESS_KEY = 'localintegrationsecret';
export const DUMMY_REGION = 'local-test-1';

/** Solo `http://localhost|127.0.0.1|[::1]:<puerto>`, sin userinfo, path, query ni fragmento. */
const LOCAL_ENDPOINT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/;

/** Devuelve el endpoint normalizado (sin barra final) o lanza un error si no es DynamoDB Local. */
export function parseLocalEndpoint(raw: string | undefined): string {
  const match = typeof raw === 'string' ? LOCAL_ENDPOINT.exec(raw) : null;
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65_535) {
    throw new Error(
      `Refusing endpoint ${JSON.stringify(raw)}: only http://localhost, http://127.0.0.1 or http://[::1] with an explicit port are allowed`,
    );
  }
  const url = new URL(raw as string);
  // Defensa adicional: el parser de URL debe coincidir con la expresión regular.
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`Refusing endpoint ${JSON.stringify(raw)}: unexpected URL components`);
  }
  return `http://${match[1]}:${port}`;
}

/**
 * Entorno saneado para el proceso de pruebas: sin ninguna variable AWS_* heredada, con
 * credenciales ficticias, sin archivos de perfil ni metadata de EC2.
 */
export function buildSanitizedEnv(
  base: NodeJS.ProcessEnv,
  endpoint: string,
  runId: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('AWS_') || key === 'DYNAMODB_LOCAL_ENDPOINT') continue;
    env[key] = value;
  }
  return {
    ...env,
    AWS_ACCESS_KEY_ID: DUMMY_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: DUMMY_SECRET_ACCESS_KEY,
    AWS_REGION: DUMMY_REGION,
    AWS_DEFAULT_REGION: DUMMY_REGION,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    [VALIDATED_ENDPOINT_VAR]: parseLocalEndpoint(endpoint),
    [RUN_ID_VAR]: runId,
  };
}

/** Verifica que el entorno actual sea el que produce `buildSanitizedEnv`; lanza si no. */
export function assertSanitizedEnv(env: NodeJS.ProcessEnv): { endpoint: string; runId: string } {
  const endpoint = parseLocalEndpoint(env[VALIDATED_ENDPOINT_VAR]);
  const runId = env[RUN_ID_VAR];
  if (!runId || !/^[a-z0-9]{6,32}$/.test(runId)) {
    throw new Error(
      `${RUN_ID_VAR} is missing or invalid: run the suite with npm run test:integration`,
    );
  }
  const expected: Record<string, string> = {
    AWS_ACCESS_KEY_ID: DUMMY_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: DUMMY_SECRET_ACCESS_KEY,
    AWS_REGION: DUMMY_REGION,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) {
      throw new Error(`Unsafe environment: ${key} is not the sanitized value`);
    }
  }
  const allowed = new Set([...Object.keys(expected), 'AWS_DEFAULT_REGION']);
  const extra = Object.keys(env).filter((key) => key.startsWith('AWS_') && !allowed.has(key));
  if (extra.length > 0) {
    throw new Error(`Unsafe environment: unexpected variables ${extra.join(', ')}`);
  }
  return { endpoint, runId };
}
