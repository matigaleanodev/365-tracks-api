import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DUMMY_ACCESS_KEY_ID,
  DUMMY_REGION,
  DUMMY_SECRET_ACCESS_KEY,
  buildSanitizedEnv,
  parseLocalEndpoint,
} from '../test-integration/support/guard.ts';

/**
 * Ejecuta las pruebas de integración contra DynamoDB Local.
 * - `DYNAMODB_LOCAL_ENDPOINT` (solo loopback) usa una instancia existente.
 * - Si no, levanta un contenedor efímero fijado por digest, publicado solo en 127.0.0.1.
 * Vitest corre con un entorno saneado: ninguna variable o perfil de AWS heredado puede cambiar el
 * destino. El contenedor se detiene siempre, también con SIGINT/SIGTERM.
 */

const IMAGE =
  'amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86';
const CONTAINER_PORT = 8000;
const READY_TIMEOUT_MS = 60_000;
const CONTAINER_LABEL = '365-tracks-api.integration=true';

const root = fileURLToPath(new URL('..', import.meta.url));
let containerName: string | undefined;
let dockerBin = 'docker';
let vitest: ChildProcess | undefined;
let stopping = false;

/** Lanza en vez de salir: así el `finally` del final siempre detiene el contenedor. */
function fail(message: string): never {
  throw new Error(message);
}

/** `DOCKER_BIN` si está definida; si no, `docker` y luego `docker.exe`. */
function resolveDocker(): string {
  const candidates = process.env.DOCKER_BIN ? [process.env.DOCKER_BIN] : ['docker', 'docker.exe'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return fail(
    `Docker not found (tried ${candidates.join(', ')}). Install Docker, set DOCKER_BIN, or set DYNAMODB_LOCAL_ENDPOINT to a local DynamoDB Local.`,
  );
}

/** El contenedor solo puede ir a un daemon local: `unix://` o `npipe://` (nunca tcp ni ssh). */
function assertLocalDaemon(): void {
  // Un docker.exe de Windows no recibe el DOCKER_HOST de WSL (WSLENV no lo reenvía): validarlo no
  // describiría al daemon real, así que se resuelve siempre con `context inspect`.
  const windowsBinary = /\.exe$/i.test(dockerBin);
  let host = windowsBinary ? undefined : process.env.DOCKER_HOST?.trim();
  if (!host) {
    const inspect = spawnSync(
      dockerBin,
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8' },
    );
    if (inspect.status !== 0) {
      fail(`could not resolve the Docker daemon endpoint:\n${inspect.stderr || inspect.stdout}`);
    }
    host = inspect.stdout.trim();
  }
  if (!/^(unix|npipe):\/\//.test(host)) {
    fail(
      `refusing Docker daemon ${JSON.stringify(host)}: only a local daemon (unix:// or npipe://) is allowed. Unset DOCKER_HOST or switch DOCKER_CONTEXT to a local context.`,
    );
  }
}

const listHint = `docker ps -a --filter label=${CONTAINER_LABEL}`;

function stopContainer(): void {
  if (!containerName) return;
  const name = containerName;
  containerName = undefined;
  // --rm en `run` elimina el contenedor al detenerse.
  spawnSync(dockerBin, ['stop', '-t', '1', name], { stdio: 'ignore' });
  spawnSync(dockerBin, ['rm', '-f', name], { stdio: 'ignore' });
}

/** Arranca el contenedor con un puerto asignado por Docker y devuelve el endpoint validado. */
function startContainer(): string {
  const name = `it365-dynamodb-local-${randomBytes(4).toString('hex')}`;
  const run = spawnSync(
    dockerBin,
    [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '--label',
      CONTAINER_LABEL,
      '-p',
      `127.0.0.1::${CONTAINER_PORT}`,
      IMAGE,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    fail(`could not start the DynamoDB Local container:\n${run.stderr || run.stdout}`);
  }
  containerName = name;
  const mapping = spawnSync(dockerBin, ['port', name, `${CONTAINER_PORT}/tcp`], {
    encoding: 'utf8',
  });
  const bound = mapping.stdout
    .split(/\r?\n/)
    .map((line) => /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim()))
    .find((match) => match !== null);
  if (mapping.status !== 0 || !bound) {
    fail(
      `container ${name} is not published on 127.0.0.1 (got ${JSON.stringify(mapping.stdout.trim())}). Leftovers can be listed with: ${listHint}`,
    );
  }
  return parseLocalEndpoint(`http://127.0.0.1:${bound[1]}`);
}

/** Espera a que responda DynamoDB Local con un ListTables real del SDK (cliente saneado). */
async function waitUntilReady(endpoint: string): Promise<void> {
  const client = new DynamoDBClient({
    endpoint,
    region: DUMMY_REGION,
    credentials: { accessKeyId: DUMMY_ACCESS_KEY_ID, secretAccessKey: DUMMY_SECRET_ACCESS_KEY },
    maxAttempts: 1,
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  try {
    while (Date.now() < deadline) {
      try {
        await client.send(new ListTablesCommand({ Limit: 1 }), {
          abortSignal: AbortSignal.timeout(2_000),
        });
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    client.destroy();
  }
  throw new Error(
    `DynamoDB Local did not become ready at ${endpoint}: ${String(lastError)}. Leftover containers: ${listHint}`,
  );
}

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  vitest?.kill(signal);
  stopContainer();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<number> {
  let endpoint: string;
  const provided = process.env.DYNAMODB_LOCAL_ENDPOINT;
  if (provided !== undefined && provided !== '') {
    try {
      endpoint = parseLocalEndpoint(provided);
    } catch (error) {
      return fail((error as Error).message);
    }
  } else {
    dockerBin = resolveDocker();
    assertLocalDaemon();
    endpoint = startContainer();
  }
  await waitUntilReady(endpoint);

  const runId = randomBytes(6).toString('hex');
  const env = buildSanitizedEnv(process.env, endpoint, runId);
  const vitestBin = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  return new Promise<number>((resolve) => {
    vitest = spawn(
      process.execPath,
      [vitestBin, 'run', '--config', 'vitest.integration.config.ts', ...process.argv.slice(2)],
      { cwd: root, env, stdio: 'inherit' },
    );
    vitest.once('error', (error) => {
      console.error(`integration: could not run vitest: ${error.message}`);
      resolve(1);
    });
    vitest.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`integration: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  stopContainer();
}
process.exit(exitCode);
