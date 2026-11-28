// Autorización de la cuenta propietaria de la playlist (una vez, y de nuevo si el refresh token se
// revoca). Lo invoca scripts/setup-github-secrets.sh, que pide las credenciales sin eco. Uso directo:
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/spotify-authorize.ts [opciones]
//   --github-secret  guarda el refresh token en el secreto SPOTIFY_REFRESH_TOKEN del entorno
//                    `secrets` de GitHub (con `gh`, por stdin)
//   --from-ssm       toma el client id y el secret de Parameter Store (con AWS_PROFILE) en vez de
//                    SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET: para reautorizar sin volver a escribirlos
//   --store          además siembra Parameter Store con AWS_PROFILE (mismas reglas que el workflow
//                    sync-secrets). Exige --github-secret: GitHub y Parameter Store quedan con el
//                    mismo token y una sincronización posterior no lo pisa.
// Levanta un servidor temporal en 127.0.0.1, imprime la URL de autorización y espera la
// redirección. El refresh token nunca se imprime: sin opciones el script solo valida el flujo.
// Requiere que la redirect URI (http://127.0.0.1:8888/callback) esté registrada en la app de
// Spotify Developer. Ver DEPLOYMENT.md.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SSM_PREFIX } from '../infra/delivery.ts';
import { PARAMETER_KEYS, readParameters, SsmParameterStore } from '../src/config/parameters.ts';
import { GITHUB_SECRET_NAMES, syncSpotifySecrets } from '../src/config/spotify-secrets-sync.ts';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  PLAYLIST_SCOPES,
} from '../src/spotify/authorization.ts';

const { values } = parseArgs({
  options: {
    store: { type: 'boolean', default: false },
    'github-secret': { type: 'boolean', default: false },
    'from-ssm': { type: 'boolean', default: false },
    port: { type: 'string', default: '8888' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if ((values.store || values['from-ssm']) && !process.env.AWS_PROFILE) {
  fail('--store and --from-ssm need AWS_PROFILE: ambient credentials are not used on purpose.');
}
let clientId = process.env.SPOTIFY_CLIENT_ID;
let clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (values['from-ssm']) {
  // Con --from-ssm se ignoran SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET del entorno.
  try {
    const parameters = await readParameters(new SsmParameterStore(new SSMClient({})), SSM_PREFIX, [
      PARAMETER_KEYS.spotifyClientId,
      PARAMETER_KEYS.spotifyClientSecret,
    ]);
    clientId = parameters.require(PARAMETER_KEYS.spotifyClientId);
    clientSecret = parameters.require(PARAMETER_KEYS.spotifyClientSecret);
  } catch (error) {
    const { name = 'Error', $metadata } = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    fail(
      `Cannot read the app credentials from Parameter Store: ${name} (HTTP ${$metadata?.httpStatusCode ?? '-'})`,
    );
  }
}
if (!clientId || !clientSecret) {
  fail('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment, or use --from-ssm.');
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  fail('--port must be an integer between 1024 and 65535.');
}
if (values.store && !values['github-secret']) {
  fail(
    '--store needs --github-secret: otherwise GitHub keeps the old token and the next sync could restore it.',
  );
}

const REPOSITORY = 'matigaleanodev/365-tracks-api';
const GITHUB_ENVIRONMENT = 'secrets';

const redirectUri = `http://127.0.0.1:${port}/callback`;
const state = randomBytes(16).toString('hex');

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/callback')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const authorizationCode = parseAuthorizationCallback(request.url, state);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Autorización recibida. Podés cerrar esta pestaña.');
      server.close();
      resolve(authorizationCode);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Autorización rechazada.');
      server.close();
      reject(error);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Scopes solicitados: ${PLAYLIST_SCOPES.join(', ')}`);
    console.log('Abrí esta URL con la cuenta propietaria de la playlist (Spotify Premium):\n');
    console.log(buildAuthorizeUrl({ clientId, redirectUri, state }));
    console.log(`\nEsperando la redirección en ${redirectUri} ...`);
  });
});

const { refreshToken } = await exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  redirectUri,
});

if (values['github-secret']) {
  // Por stdin: el token no aparece en la línea de comandos ni en el historial.
  const result = spawnSync(
    'gh',
    [
      'secret',
      'set',
      GITHUB_SECRET_NAMES.refreshToken,
      '--env',
      GITHUB_ENVIRONMENT,
      '--repo',
      REPOSITORY,
    ],
    {
      input: refreshToken,
      stdio: ['pipe', 'ignore', 'inherit'],
      // `gh` no necesita las credenciales de la app.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('SPOTIFY_')),
      ),
    },
  );
  if (result.status !== 0) fail('gh secret set falló: el refresh token no se guardó en GitHub.');
  console.log(
    `Refresh token guardado en GitHub (${REPOSITORY}, entorno ${GITHUB_ENVIRONMENT}, ${GITHUB_SECRET_NAMES.refreshToken}).`,
  );
}

if (values.store) {
  try {
    const store = new SsmParameterStore(new SSMClient({}));
    const results = await syncSpotifySecrets(
      store,
      SSM_PREFIX,
      { clientId, clientSecret, refreshToken },
      { tokenHistory: (name) => store.history(name) },
    );
    for (const { name, action } of results) console.log(`${name}: ${action}`);
  } catch (error) {
    // Solo el tipo y el estado HTTP: un mensaje de validación de AWS podría citar el valor.
    const { name = 'Error', $metadata } = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    fail(
      `Parameter Store no se actualizó: ${name} (HTTP ${$metadata?.httpStatusCode ?? '-'}). GitHub ya tiene el token: corré sync-secrets.`,
    );
  }
}

if (!values.store && !values['github-secret']) {
  console.log('Flujo validado. No se guardó nada: repetí con --github-secret y/o --store.');
}
