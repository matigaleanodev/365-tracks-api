# Despliegue

Cómo levantar y desplegar el proyecto. Los workflows son manuales y el repositorio no necesita bootstrap de CDK.

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
   - `foundation`: revisores requeridos.
   - `plan`: sin revisores.
   - `production`: revisores requeridos.

En cada comando, reemplazá `PERFIL_ADMIN` por un perfil local de AWS CLI con los permisos de administración necesarios. Antes de cada mutación, verificá la identidad y comprobá la cuenta y la región de destino:

```bash
aws sts get-caller-identity --profile PERFIL_ADMIN --region us-east-1
```

La cuenta debe ser `650387442642` y la región `us-east-1`; si no coinciden, no continuar.

## Primer despliegue

Los workflows solo corren desde `main`, así que primero hace falta un release (`release/x.x.x` → `main`).

1. Ejecutar el workflow **foundation** y aprobar el entorno `foundation`. Crea el bucket y los siete roles.
2. Ejecutar el workflow **deploy**. El job `plan` valida, empaqueta, sube los assets y crea el change set (queda resumido en la página del run); el job `execute` espera la aprobación del entorno `production` y ejecuta ese mismo change set.

El job `plan` se detiene si el change set toca IAM o si elimina o reemplaza la tabla.

## Configuración de la aplicación

`PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SYNC_TIME_UTC` y `PLAYLIST_SCHEDULE_ENABLED` se leen en el synth (contexto de CDK, luego variables de entorno, luego defaults). El workflow **deploy** controla los dos schedules con inputs booleanos, desmarcados por defecto:

- `schedule_enabled`: reposición diaria del catálogo (00:00 UTC).
- `playlist_schedule_enabled`: sincronización anual de la playlist (12:30 UTC).

Por defecto **ambos schedules quedan deshabilitados**. Cada despliegue fija su estado de forma explícita (el workflow se los pasa a CDK como contexto e ignora `PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SCHEDULE_ENABLED` y `PLAYLIST_SYNC_TIME_UTC` heredadas), así que un despliegue posterior con los inputs desmarcados los vuelve a deshabilitar. El job `plan` sintetiza una sola vez y falla, antes de crear el change set, si el estado sintetizado difiere de los inputs; luego prepara el change set con ese mismo ensamblado verificado. El resumen del run lista cada schedule con su estado y hora UTC. Habilitá cada uno recién cuando existan sus credenciales y se haya verificado una ejecución manual. La hora de la playlist debe ser 12:00 UTC o posterior.

### Credenciales (Parameter Store)

Las credenciales son parámetros `SecureString` bajo `/tracks365`, cifrados con la clave por defecto `aws/ssm` (no hacen falta permisos de KMS extra). Las crea un administrador o la persona propietaria, nunca el pipeline, y no se versionan. Cada rol de Lambda lee solo lo que necesita:

| Parámetro                               | Contenido                                        | Lo leen            |
| --------------------------------------- | ------------------------------------------------ | ------------------ |
| `/tracks365/spotify/client-id`          | Client id de la app de Spotify                   | generate, playlist |
| `/tracks365/spotify/client-secret`      | Client secret de la app de Spotify               | generate, playlist |
| `/tracks365/spotify/refresh-token`      | Refresh token del dueño (lo escribe el script)   | playlist (rota)    |
| `/tracks365/openai/api-key`             | API key de OpenAI                                | generate           |
| `/tracks365/openai/model`               | Nombre del modelo de OpenAI a usar (obligatorio) | generate           |
| `/tracks365/selection/criteria-weights` | JSON opcional con los seis pesos de criterios    | generate           |

```bash
aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString \
  --name /tracks365/openai/model --value "<modelo>"        # repetir por parámetro; no pegar secretos en terminales compartidas
```

### Configuración manual en Spotify Developer

1. Con la cuenta propietaria (en Development Mode se requiere Spotify **Premium**), crear una app en el Spotify Developer Dashboard y registrar la redirect URI `http://127.0.0.1:8888/callback` (IP loopback literal; `localhost` no se acepta).
2. Guardar el client id y el secret en Parameter Store como arriba.
3. Ejecutar la autorización inicial desde una máquina de confianza: `SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... AWS_PROFILE=PERFIL_AUTORIZADO node scripts/spotify-authorize.ts --store`. Pide solo `playlist-modify-public` y guarda el refresh token sin imprimirlo. Sin `--store` solo valida el flujo.
4. En Development Mode el refresh token puede vencer (alrededor de seis meses) o ser revocado; la sincronización falla entonces con `invalid_grant` y hay que repetir el paso 3.
5. `AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync` es un dry-run: no modifica playlists ni registros de sincronización, y solo considera días terminados en todas las zonas (desde las 12:00 UTC de D+1). Con un registro guardado de la playlist del año, lee la playlist real y reporta lo que agregaría; sin registro, no consulta Spotify y el resultado es una cota superior (al escribir se reutiliza una playlist existente con el mismo nombre en vez de duplicarla). Su única escritura posible es guardar en Parameter Store un refresh token que Spotify haya rotado (requiere `ssm:PutParameter`), porque descartarlo podría invalidar la autorización. Si ese guardado falla, la ejecución se aborta (código 1). `--write` es la única forma de crear playlists o agregar canciones. Si el script rota y guarda el token mientras una Lambda de playlist está caliente, esa instancia sigue con el token anterior hasta un arranque en frío: no ejecutar el script mientras el Scheduler de playlist pueda estar corriendo.

### CORS

El workflow **deploy** recibe el input `cors_allowed_origins` (default `http://localhost:4200`) y lo pasa al synth como `CORS_ALLOWED_ORIGINS`. `infra/config.ts` es el único lugar que lo valida:

- Orígenes separados por coma (`esquema://host[:puerto]`, sin ruta ni barra final); los duplicados se ignoran.
- Se rechaza `*`. Se exige `https`, salvo `http` para `localhost` / `127.0.0.1`.
- Vacío = sin configuración CORS.
- Cada despliegue define la lista **completa**: para sumar el dominio definitivo del frontend, ejecutá el workflow con `http://localhost:4200,https://<dominio>` (y quitá localhost cuando ya no haga falta). El resumen del run muestra la lista vigente; el change set muestra el cambio en la API.

Probalo con `curl -i -H "Origin: https://<origen>" <url-api>/api/tracks` y buscá `access-control-allow-origin`.
