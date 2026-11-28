# Despliegue

Cómo levantar y desplegar el proyecto. Integrar en `main` despliega automáticamente: ese merge es la autorización. Ejecutar un workflow a mano es la excepción. El repositorio no necesita bootstrap de CDK.

## Modelo

- Cuenta `650387442642`, región `us-east-1` (fijas en `infra/delivery.ts`).
- Dos stacks: **`tracks365-foundation`** (bucket de assets y roles) y **`tracks365-api`** (la aplicación).
- El stack de la API **no crea ni modifica IAM**: importa los roles que crea la fundación. Los assets van al bucket de la fundación (`CliCredentialsStackSynthesizer`).
- Todos los roles de la fundación llevan la boundary `tracks365-ceiling`, que es la unión de sus permisos y que crea un administrador (prerrequisito, el pipeline no puede editarla).
- Autenticación con OIDC de GitHub y subject inmutable (owner e id de repositorio). Sin claves de larga duración y sin variables de GitHub.

| Rol                                                                                 | Lo asume                                     | Para qué                                          |
| ----------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `tracks365-foundation`                                                              | workflow `foundation` (entorno `foundation`) | Gestiona el change set de la fundación            |
| `tracks365-foundation-cloudformation`                                               | CloudFormation                               | Crea los roles (solo con la boundary) y el bucket |
| `tracks365-prepare`                                                                 | job `plan` (entorno `plan`)                  | Sube assets y crea el change set                  |
| `tracks365-execute`                                                                 | job `execute` (entorno `production`)         | Ejecuta el change set revisado                    |
| `tracks365-cloudformation`                                                          | CloudFormation                               | Crea los recursos de la API                       |
| `tracks365-secrets`                                                                 | workflow `sync-secrets` (entorno `secrets`)  | Escribe los parámetros de Spotify                 |
| `tracks365-http`, `tracks365-generate`, `tracks365-playlist`, `tracks365-scheduler` | Lambda / Scheduler                           | Runtime, con permisos mínimos                     |

## Prerrequisitos (una vez, con permisos de administración)

Los documentos están generados en `deploy/admin/` (`npm run admin:policies` los regenera; un test verifica que estén al día).

1. Provider OIDC `token.actions.githubusercontent.com` en la cuenta (ya existe si otro repo lo usa).
2. Política gestionada `tracks365-ceiling`:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy --policy-name tracks365-ceiling \
     --policy-document file://deploy/admin/tracks365-ceiling.policy.json
   ```
3. Rol de CloudFormation de la fundación:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation-cloudformation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation-cloudformation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
   ```
4. Rol del pipeline de la fundación:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation.policy.json
   ```
5. Entornos de GitHub (Settings → Environments), todos limitados a la rama `main`:
   - `foundation`: revisores requeridos (cambia roles IAM).
   - `plan`: sin revisores.
   - `production`: sin revisores. Integrar el release en `main` es la autorización.
   - `secrets`: sin revisores (su único workflow es manual). Lo crea `scripts/setup-github-secrets.sh`.

Cuando cambian los roles (un rol nuevo o permisos nuevos), el administrador publica los documentos regenerados antes de ejecutar **foundation**: una versión nueva por defecto del ceiling y la política del rol de CloudFormation de la fundación.

```bash
aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy-version --set-as-default \
  --policy-arn arn:aws:iam::650387442642:policy/tracks365-ceiling \
  --policy-document file://deploy/admin/tracks365-ceiling.policy.json
aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
  --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
```

Una política gestionada guarda como máximo cinco versiones: si hace falta, borrar antes la más vieja que no sea la por defecto (`iam list-policy-versions`, `iam delete-policy-version`). No puede superar 6144 caracteres sin espacios: `npm run admin:policies` compacta el ceiling sin cambiar sus permisos y un test verifica el tamaño.

En cada comando, reemplazá `PERFIL_ADMIN` por un perfil local de AWS CLI con los permisos de administración necesarios. Antes de cada mutación, verificá la identidad y comprobá la cuenta y la región de destino:

```bash
aws sts get-caller-identity --profile PERFIL_ADMIN --region us-east-1
```

La cuenta debe ser `650387442642` y la región `us-east-1`; si no coinciden, no continuar.

## Primer despliegue

Los workflows solo corren desde `main`, así que primero hace falta un release (`release/x.x.x` → `main`).

1. Ejecutar el workflow **foundation** y aprobar el entorno `foundation`. Crea el bucket y los ocho roles. Sigue siendo manual: cambia roles de entrega.
2. Integrar el release en `main` dispara **deploy**. El job `plan` valida, empaqueta, sube los assets y crea el change set (queda resumido en la página del run); el job `execute` ejecuta ese mismo change set sin otra aprobación; después el job `release` publica el tag y la release de GitHub `v<versión de package.json>` si todavía no existen. **deploy** también puede ejecutarse a mano desde `main`, con la misma configuración y sin inputs.

El job `plan` se detiene si el change set toca IAM o elimina o reemplaza la tabla.

### Cambios de roles antes de un release

El stack de la API importa sus roles, así que un release cuyo código necesita un rol o permisos nuevos tiene que encontrarlos ya creados. Los workflows solo corren desde `main`, que todavía tiene el release anterior, así que un administrador actualiza la fundación **antes** de integrar ese release, desde la rama del release, con el mismo template y las mismas comprobaciones que el workflow (después de publicar el ceiling y la política regenerados, ver Prerrequisitos):

```bash
npm ci && npm run synth:foundation
P="--profile PERFIL_ADMIN --region us-east-1"; S=tracks365-foundation; C=admin-$(date +%Y%m%d%H%M%S)
aws $P cloudformation create-change-set --stack-name $S --change-set-name $C --change-set-type UPDATE \
  --template-body file://cdk.foundation.out/Tracks365Foundation.template.json \
  --role-arn arn:aws:iam::650387442642:role/tracks365-foundation-cloudformation --capabilities CAPABILITY_NAMED_IAM
aws $P cloudformation wait change-set-create-complete --stack-name $S --change-set-name $C
aws $P cloudformation describe-change-set --stack-name $S --change-set-name $C \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
# Continuar solo si todos los cambios son AWS::IAM::Role o recursos S3, Add o Modify, sin reemplazo.
aws $P cloudformation execute-change-set --stack-name $S --change-set-name $C
aws $P cloudformation wait stack-update-complete --stack-name $S
```

Con el release ya en `main`, el workflow **foundation** no encontraría nada que cambiar; solo hace falta para el próximo cambio de roles que pase por `main`.

## Configuración de la aplicación

La configuración del despliegue está versionada en [`deploy/production.json`](deploy/production.json):

```json
{
  "corsAllowedOrigins": ["https://daywave.matiasgaleano.dev"],
  "scheduleEnabled": false,
  "playlistScheduleEnabled": false
}
```

- `scheduleEnabled`: reposición diaria del catálogo (00:00 UTC).
- `playlistScheduleEnabled`: sincronización de la playlist anual (12:30 UTC).

En el archivo **ambos schedules están deshabilitados**. Cambiar su estado, o la lista de CORS, es un cambio revisado a ese archivo que llega a producción con el siguiente release; un despliegue de código nunca los cambia por sí solo. El workflow se los pasa a CDK como contexto e ignora `PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SCHEDULE_ENABLED` y `PLAYLIST_SYNC_TIME_UTC` heredadas. El job `plan` sintetiza una sola vez y falla, antes de crear el change set, si el estado sintetizado difiere del archivo; luego prepara el change set con ese mismo ensamblado verificado. El resumen del run lista cada schedule con su estado y hora UTC. Habilitá cada uno recién cuando existan sus credenciales y se haya verificado una ejecución manual. La hora de la playlist debe ser 12:00 UTC o posterior.

### Credenciales (Parameter Store)

Parameter Store es la fuente operativa que lee el backend: parámetros `SecureString` bajo `/tracks365`, cifrados con la clave por defecto `aws/ssm` (no hacen falta permisos de KMS extra). No se versionan y nunca llegan al frontend. Cada rol de Lambda lee solo lo que necesita:

| Parámetro                                      | Contenido                                              | Lo leen            | Lo escriben              |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------ | ------------------------ |
| `/tracks365/spotify/client-id`                 | Client id de la app de Spotify                         | generate, playlist | `sync-secrets`           |
| `/tracks365/spotify/client-secret`             | Client secret de la app de Spotify                     | generate, playlist | `sync-secrets`           |
| `/tracks365/spotify/refresh-token`             | Refresh token de la cuenta dueña                       | playlist           | `sync-secrets`, playlist |
| `/tracks365/spotify/refresh-token-seed-sha256` | SHA-256 del último refresh token sembrado desde GitHub | -                  | `sync-secrets`           |
| `/tracks365/openai/api-key`                    | API key de OpenAI                                      | generate           | administrador (manual)   |
| `/tracks365/openai/model`                      | Nombre del modelo de OpenAI a usar (obligatorio)       | generate           | administrador (manual)   |
| `/tracks365/selection/criteria-weights`        | JSON opcional con los seis pesos de criterios          | generate           | administrador (manual)   |

#### Credenciales de Spotify: GitHub Secrets → Parameter Store

La fuente de las credenciales de Spotify es el entorno `secrets` del repositorio de GitHub, con tres secretos: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` y `SPOTIFY_REFRESH_TOKEN`. El workflow manual **sync-secrets** (sin inputs, solo desde `main`) asume `tracks365-secrets` por OIDC y los copia a Parameter Store. Ese rol solo puede leer y escribir los cuatro parámetros de Spotify de arriba, y leer el historial del refresh token.

- Valida que estén los tres secretos y que no estén vacíos antes de escribir nada; nunca escribe un valor vacío.
- Es idempotente: escribe solo lo que difiere e imprime solo nombres de parámetros y acciones (`created`, `updated`, `unchanged`, `kept-rotated`).
- Spotify puede devolver un refresh token nuevo cuando la Lambda de la playlist renueva el access token; la Lambda lo guarda en Parameter Store. El parámetro de huella guarda el SHA-256 del último valor sembrado desde GitHub: mientras `SPOTIFY_REFRESH_TOKEN` no cambie, una sincronización posterior conserva el token rotado (`kept-rotated`) en vez de restaurar el viejo. Un valor nuevo en GitHub (una autorización nueva) se siembra y lo reemplaza; un valor que Parameter Store ya tuvo en una versión anterior (su historial) nunca se restaura. A su vez, la Lambda no guarda una rotación si el parámetro ya no tiene el token del que partió (una instancia caliente después de una sincronización o de una autorización nueva).
- Parameter Store no admite escrituras condicionales: no correr **sync-secrets** mientras el Scheduler de la playlist pueda estar corriendo.
- Los despliegues de código no dependen de este workflow. Se corre en la carga inicial y después de cada rotación.

Carga inicial o rotación, desde WSL en la raíz del repositorio (requiere `gh` autenticado con permisos de administración del repositorio, Node 24 y `npm ci`):

```bash
bash scripts/setup-github-secrets.sh
```

El script pide los valores sin eco y los pasa a `gh secret set` por stdin, así que nada queda en el historial. Crea el entorno `secrets` limitado a `main`, puede quitar los revisores de `production` (solo después de comprobar que `main` exige pull request y de limitar `plan` y `production` a `main`), ejecuta la autorización de Spotify para obtener el refresh token (o acepta uno existente) y también puede sembrar Parameter Store en el momento con `AWS_PROFILE=architect`. Después:

```bash
gh workflow run sync-secrets.yml --repo matigaleanodev/365-tracks-api --ref main
```

Los parámetros de OpenAI se siguen creando a mano. La key se lee sin eco para que no quede en el historial:

```bash
bash -c 'read -rs -p "API key de OpenAI: " key; echo; [[ -n $key ]] || exit 1
  aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString --overwrite \
    --name /tracks365/openai/api-key --value file:///dev/stdin <<< "$key"'
aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString --overwrite \
  --name /tracks365/openai/model --value "<modelo>"
```

### Configuración manual en Spotify Developer

1. Con la cuenta propietaria (en Development Mode se requiere Spotify **Premium**), crear una app en el Spotify Developer Dashboard, elegir la Web API y registrar la redirect URI `http://127.0.0.1:8888/callback` (IP loopback literal; `localhost` no se acepta). El client id y el secret están en la configuración de la app.
2. Ejecutar `bash scripts/setup-github-secrets.sh` y aceptar la autorización OAuth. Pide solo `playlist-modify-public` y `playlist-read-private` (listar las playlists de la cuenta para encontrar una por nombre lo exige, aunque sean públicas; en Development Mode `GET /users/{id}/playlists` responde 403), abre un servidor temporal en `127.0.0.1:8888` y guarda el refresh token en GitHub (y en Parameter Store si se pide) sin imprimirlo. WSL 2 reenvía `127.0.0.1` al navegador de Windows.
3. El refresh token puede revocarse o vencer; la sincronización falla entonces con `invalid_grant` y hay que repetir el paso 2 y después **sync-secrets**. Un token conserva los scopes concedidos al emitirse: después de un cambio de scopes, reautorizar antes de la próxima sincronización. Para reautorizar sin volver a escribir las credenciales de la app: `AWS_PROFILE=architect AWS_REGION=us-east-1 node scripts/spotify-authorize.ts --from-ssm --github-secret --store`.

4. `AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync` es un dry-run: no modifica playlists ni registros de sincronización, y solo considera días terminados en todas las zonas (desde las 12:00 UTC de D+1). Con un registro guardado de la playlist del año, lee la playlist real y reporta lo que agregaría; sin registro, no consulta Spotify y el resultado es una cota superior (al escribir se reutiliza una playlist existente con el mismo nombre en vez de duplicarla). Su única escritura posible es guardar en Parameter Store un refresh token que Spotify haya rotado (requiere `ssm:PutParameter`), porque descartarlo podría invalidar la autorización. Si ese guardado falla, la ejecución se aborta (código 1). `--write` es la única forma de crear playlists o agregar canciones. Si el script rota y guarda el token mientras una Lambda de playlist está caliente, esa instancia sigue con el token anterior hasta un arranque en frío: no ejecutar el script mientras el Scheduler de playlist pueda estar corriendo.

### Herramientas del operador

CLIs privados con un `AWS_PROFILE` autorizado; ninguno se expone por HTTP y ningún rol de Lambda puede ejecutarlos.

- `node scripts/catalog.ts list [--json]`: todo el catálogo en orden de fecha con estado (`published`, `prepared`, `incomplete`), título, artista, ID de Spotify, nota y fechas sin canción. Solo lee.
- `node scripts/maintenance.ts replace --date=AAAA-MM-DD --file=cancion.json [--write]`: reemplaza una canción cuya fecha todavía no empezó en ninguna zona (UTC+14), con la misma validación y reglas de repetición que `load-track`. Si la nueva no se puede guardar, devuelve la anterior e informa qué quedó en la fecha. `remove` rechaza las mismas fechas. Una canción publicada solo admite `edit-description`; una incompleta en una fecha ya iniciada sigue sin publicarse hasta que la corrija un administrador.
- `node scripts/spotify-check.ts <search|track|verify-catalog> [--market=XX]`: consultas de solo lectura a Spotify con las credenciales de la app; `verify-catalog` comprueba que los IDs de Spotify próximos sigan existiendo y coincidan.
- `node scripts/playlist.ts info`: cuenta autorizada y playlists anuales registradas con su titular.
- `node scripts/playlist.ts rehearse [--write] [--playlist-id=ID] [--sample=archivo.json] [--now=ISO]`: corre la sincronización real contra una playlist de ensayo de la cuenta autorizada, con canciones de muestra en memoria. Por defecto usa la playlist pública `Daywave - Test` de la cuenta (con `--write` la crea si falta; rechaza nombres de playlist anual), una muestra integrada de tres canciones conocidas que se resuelven en Spotify con fechas 2027-01-01 a 2027-01-03, y el reloj `2027-01-03T12:30:00Z`, así que solo entran las dos primeras fechas. Rechaza playlists anuales registradas, playlists de otro titular y muestras con canciones del catálogo todavía no elegibles para una playlist pública; con `--write` corre dos veces y falla si la segunda agrega algo.

### CORS

`corsAllowedOrigins` de `deploy/production.json` llega al synth como `CORS_ALLOWED_ORIGINS`. `infra/config.ts` es el único lugar que lo valida:

- Orígenes con forma `esquema://host[:puerto]`, sin ruta ni barra final; los duplicados se ignoran.
- `*` se rechaza. Se exige `https`, salvo `http` para `localhost` / `127.0.0.1`.
- Lista vacía = sin configuración CORS.
- El archivo tiene la lista **completa** de orígenes de producción: solo el dominio público del frontend. El desarrollo local del frontend usa fixtures o una API local, no la de producción.

Probalo con `curl -i -H "Origin: https://<origen>" <url-api>/api/tracks` y buscá `access-control-allow-origin`.

## Rollback

Los datos no forman parte de ningún rollback: la tabla tiene `DeletionPolicy: Retain` y recuperación point-in-time, y ningún paso de esta sección la modifica.

- **Falla el despliegue.** Si el change set falla, CloudFormation vuelve solo al template anterior y el job `execute` termina en error. Antes de reintentar, leé el estado real del stack (`aws --profile PERFIL_AUTORIZADO --region us-east-1 cloudformation describe-stacks --stack-name tracks365-api`): `UPDATE_ROLLBACK_COMPLETE` admite un nuevo despliegue; cualquier otro estado se revisa a mano. Un workflow fallido después de `execute` no implica que producción haya quedado sin cambios.
- **Una versión publicada falla.** La corrección es un `release/x.x.x` nuevo hacia `main` con el arreglo o la reversión del cambio; el merge lo despliega con las mismas verificaciones. Para frenar los procesos editoriales, ese release deja `scheduleEnabled` y `playlistScheduleEnabled` en `false`. Una reversión conserva en `corsAllowedOrigins` el origen del frontend publicado mientras lo use, y el test de configuración lo exige.
- **Orden obligatorio para revertir permisos.** Los roles se agregan, nunca se reemplazan: una versión anterior de la API funciona con una fundación más nueva, pero no al revés. Revertir en este orden, cada paso después de que el anterior terminó bien:
  1. La API, a una versión que ya no use los roles ni los permisos nuevos (un release; mientras tanto CloudFormation necesita esos permisos para borrar los recursos que sobran).
  2. La fundación, con un change set del template anterior guardado y los mismos comandos de "Cambios de roles antes de un release". En este caso el change set puede incluir `Remove` solo de los roles que agregó el release revertido y que la API ya no usa; ningún reemplazo ni cambio en el bucket.
  3. La política `project` de `tracks365-foundation-cloudformation`, con `iam put-role-policy` y la copia guardada antes del cambio (la anterior no puede borrar los roles nuevos).
  4. El ceiling: `iam list-policy-versions` y `iam set-default-policy-version --version-id vN` sobre `tracks365-ceiling` (las versiones anteriores se conservan).
- **Rollback trabado.** Si un rollback de `tracks365-api` queda en `UPDATE_ROLLBACK_FAILED`, un administrador lo destraba con `cloudformation continue-update-rollback --stack-name tracks365-api` (y `--resources-to-skip` solo para recursos que se verificaron a mano); `tracks365-execute` no tiene ese permiso.

## Señales de salud del catálogo

Cada ejecución de la Lambda de reposición registra un evento JSON `catalog-replenish` (solo fechas y conteos, nunca títulos ni artistas) y devuelve los mismos campos. `status` es `catalog-complete`, `progressed`, `stalled-no-time` (quedaba poco tiempo en la invocación: no se empieza nada y la ejecución termina sin error), `stalled-budget-exhausted` (el tiempo se agotó antes de completar alguna fecha; la ejecución falla) o `failed` (una fecha falló; la ejecución falla). También se informan `incompleteCount`, `missingCount`, `preparedAhead` (fechas completas consecutivas desde el inicio de la ventana, que es ayer en UTC) y `runwayLow` (`preparedAhead` menor que 7).

El stack no incluye recursos de alarma. Cuando se habiliten los schedules, estas condiciones deberían avisar al responsable:

- la Lambda termina con error (`failed` o `stalled-budget-exhausted`), o `stalled-*` se repite en ejecuciones consecutivas;
- `runwayLow` es `true`;
- `incompleteCount` es mayor que 0 (las fechas incompletas nunca se reparan solas);
- ninguna ejecución registró `progressed` ni `catalog-complete` durante más que el intervalo del schedule, o la ventana no avanza cerca de la fecha actual.
