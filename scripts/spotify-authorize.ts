// Autorización inicial de la cuenta propietaria de la playlist (se hace una vez, y cada ~6 meses
// si el refresh token vence o se revoca). Uso:
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/spotify-authorize.ts
//   (agregar --store con AWS_PROFILE para guardar el refresh token en Parameter Store)
// Levanta un servidor temporal en 127.0.0.1, imprime la URL de autorización y espera la
// redirección. El refresh token nunca se imprime: sin --store el script solo valida el flujo.
// Requiere que la redirect URI (http://127.0.0.1:8888/callback) esté registrada en la app de
// Spotify Developer. Ver DEPLOYMENT.md.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SSM_PREFIX } from '../infra/delivery.ts';
import { PARAMETER_KEYS, parameterName, SsmParameterStore } from '../src/config/parameters.ts';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  PLAYLIST_SCOPES,
} from '../src/spotify/authorization.ts';

const { values } = parseArgs({
  options: {
    store: { type: 'boolean', default: false },
    port: { type: 'string', default: '8888' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  fail('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the environment.');
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  fail('--port must be an integer between 1024 and 65535.');
}
if (values.store && !process.env.AWS_PROFILE) {
  fail('--store needs AWS_PROFILE: ambient credentials are not used on purpose.');
}

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

if (values.store) {
  const name = parameterName(SSM_PREFIX, PARAMETER_KEYS.spotifyRefreshToken);
  await new SsmParameterStore(new SSMClient({})).put(name, refreshToken);
  console.log(`Refresh token guardado en Parameter Store (${name}).`);
} else {
  console.log('Flujo validado. No se guardó nada: repetí con --store para guardar el token.');
}
