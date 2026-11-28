// Sincroniza las credenciales de Spotify hacia Parameter Store. Lo usa el workflow sync-secrets.yml
// con los secretos del entorno `secrets` de GitHub y el rol OIDC `tracks365-secrets`.
// Lee SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET y SPOTIFY_REFRESH_TOKEN del entorno. Nunca imprime
// valores: solo el nombre de cada parámetro y la acción. Ver src/config/spotify-secrets-sync.ts.
import { SSMClient } from '@aws-sdk/client-ssm';
import { SSM_PREFIX } from '../infra/delivery.ts';
import { SsmParameterStore } from '../src/config/parameters.ts';
import {
  GITHUB_SECRET_NAMES,
  MissingSecretsError,
  syncSpotifySecrets,
} from '../src/config/spotify-secrets-sync.ts';

if (process.env.GITHUB_ACTIONS !== 'true' && !process.env.AWS_PROFILE) {
  console.error(
    'Fuera de GitHub Actions hace falta AWS_PROFILE: no se usan credenciales ambientales.',
  );
  process.exit(1);
}

try {
  const store = new SsmParameterStore(new SSMClient({}));
  const results = await syncSpotifySecrets(
    store,
    SSM_PREFIX,
    {
      clientId: process.env[GITHUB_SECRET_NAMES.clientId],
      clientSecret: process.env[GITHUB_SECRET_NAMES.clientSecret],
      refreshToken: process.env[GITHUB_SECRET_NAMES.refreshToken],
    },
    { tokenHistory: (name) => store.history(name) },
  );
  for (const { name, action } of results) console.log(`${name}: ${action}`);
} catch (error) {
  if (error instanceof MissingSecretsError) {
    console.error(error.message);
    process.exit(1);
  }
  // Solo el tipo de error y el estado HTTP: un mensaje de validación de AWS podría citar el valor.
  const { name = 'Error', $metadata } = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  console.error(`La sincronización falló: ${name} (HTTP ${$metadata?.httpStatusCode ?? '-'})`);
  process.exit(1);
}
