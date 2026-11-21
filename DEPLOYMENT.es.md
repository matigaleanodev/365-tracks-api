# Despliegue

Guía para el primer despliegue y los siguientes. Nada se despliega solo: los workflows son manuales y el repositorio no necesita bootstrap de CDK.

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

### Actualizar una instalación existente (rol de playlist y permisos de Parameter Store)

El techo y la política del rol de CloudFormation de la fundación crecieron (nuevo rol `tracks365-playlist`, Parameter Store y un segundo schedule). Antes de ejecutar el workflow **foundation**, un administrador debe publicar los documentos regenerados:

```bash
aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy-version --policy-arn arn:aws:iam::650387442642:policy/tracks365-ceiling \
  --policy-document file://deploy/admin/tracks365-ceiling.policy.json --set-as-default
aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
  --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
```

Después ejecutar **foundation** (crea el rol `playlist` y actualiza los demás) y luego **deploy**. Una política administrada admite como máximo cinco versiones: si se alcanzó el límite, borrar antes la versión no predeterminada más antigua.

## Primer despliegue

Los workflows solo corren desde `main`, así que primero hace falta un release (`release/x.x.x` → `main`).

1. Ejecutar el workflow **foundation** y aprobar el entorno `foundation`. Crea el bucket y los siete roles.
2. Ejecutar el workflow **deploy**. El job `plan` valida, empaqueta, sube los assets y crea el change set (queda resumido en la página del run); el job `execute` espera la aprobación del entorno `production` y ejecuta ese mismo change set.

El job `plan` se detiene si el change set toca IAM o si elimina o reemplaza la tabla.

## Configuración de la aplicación

`PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SYNC_TIME_UTC` y `PLAYLIST_SCHEDULE_ENABLED` se leen en el synth (contexto de CDK o variables de entorno). El workflow no las define: con los defaults, **ambos schedules quedan deshabilitados**. Habilitá cada uno recién cuando existan sus credenciales y se haya verificado una ejecución manual. La hora de la playlist debe ser 12:00 UTC o posterior.

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

### Operar los procesos musicales

```bash
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts status                          # solo lectura
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts replenish --live --write --max-new=3
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync                           # simulación
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync --write
```

`replenish --live` escribe canciones futuras en la tabla y consume cuota de OpenAI y Spotify; `--write` en la playlist crea o modifica una playlist pública real. Revisá primero la simulación. Las canciones creadas antes de que la descripción fuera obligatoria se informan como `incomplete` y hay que completarlas (ver Carga manual).

### CORS

El workflow **deploy** recibe el input `cors_allowed_origins` (default `http://localhost:4200`) y lo pasa al synth como `CORS_ALLOWED_ORIGINS`. `infra/config.ts` es el único lugar que lo valida:

- Orígenes separados por coma (`esquema://host[:puerto]`, sin ruta ni barra final); los duplicados se ignoran.
- Se rechaza `*`. Se exige `https`, salvo `http` para `localhost` / `127.0.0.1`.
- Vacío = sin configuración CORS.
- Cada despliegue define la lista **completa**: para sumar el dominio definitivo del frontend, ejecutá el workflow con `http://localhost:4200,https://<dominio>` (y quitá localhost cuando ya no haga falta). El resumen del run muestra la lista vigente; el change set muestra el cambio en la API.

Probalo con `curl -i -H "Origin: https://<origen>" <url-api>/api/tracks` y buscá `access-control-allow-origin`.

## Carga manual de canciones

Mientras no exista la selección automática, las canciones se cargan con un CLI (no hay endpoint público de escritura). Reutiliza `DailyTrack` y `DynamoTrackRepository`: la escritura es condicional, así que una fecha existente nunca se sobrescribe.

```bash
# 1. Validar sin tocar AWS
node scripts/load-track.ts --file track.json --dry-run
# 2. Escribir (exige un perfil autorizado; no usa credenciales ambientales)
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/load-track.ts --file track.json
```

`track.json` (`-` lee la entrada estándar):

```json
{
  "date": "2027-01-01",
  "title": "…",
  "artist": "…",
  "album": "…",
  "releaseYear": 1991,
  "spotifyTrackId": "<22 caracteres>",
  "spotifyUrl": "https://open.spotify.com/track/<spotifyTrackId>",
  "selectionCriterion": "…",
  "coverUrl": "https://…",
  "description": "…"
}
```

`coverUrl` y `description` son opcionales; `createdAt` lo fija el CLI; se rechazan campos desconocidos y fechas anteriores al inicio de la publicación (`2027-01-01`). La salida es `created` o `already-exists` (con la canción almacenada, que no se modifica). El perfil necesita `dynamodb:PutItem` y `dynamodb:GetItem` sobre la tabla; no se usan los roles del pipeline.

### Preparar varias fechas (array JSON)

Un archivo con un **array** JSON de esos mismos objetos importa muchas fechas a la vez (hasta 366). Todo se valida antes de escribir:

```bash
node scripts/load-track.ts --file mes.json --dry-run
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/load-track.ts --file mes.json
```

- Un registro inválido, una fecha o un `spotifyTrackId` repetidos dentro del archivo, o un `spotifyTrackId` ya guardado en otra fecha abortan todo el lote: no se escribe nada y se informa cada registro por posición y fecha.
- Las fechas que ya tienen canción se informan como `already-exists` y nunca se sobrescriben, así que el mismo archivo puede ejecutarse de nuevo sin riesgo.
- `--dry-run` solo valida el archivo (nunca toca AWS, por lo que no comprueba fechas ni IDs guardados); la ejecución real también revisa el catálogo guardado y necesita `dynamodb:Query` además de `GetItem` y `PutItem`.

### Estado del catálogo

```bash
node scripts/catalog.ts status --local                 # repositorio en memoria, sin AWS
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts status   # solo lectura sobre la tabla
```

Imprime la ventana de 30 fechas, cuántas están preparadas, cuáles incompletas y cuáles faltan. `replenish` ejecuta la reposición (`--local` para pruebas con selección de mentira; contra la tabla exige además `--write`; `--live` usa la selección real). `--now=<instante ISO>` fija el reloj.

## Prueba de integración (Angular → API Gateway → Lambda → DynamoDB)

1. **Cargar** una canción real con el CLI (primero `--dry-run`).
2. **Visibilidad (API desplegada).** Antes de su fecha, `GET /api/tracks/<fecha>` debe responder `404 TRACK_NOT_FOUND` y `GET /api/tracks` no debe listarla; `GET /api/tracks/today` responde 404 hasta que haya una canción publicada para el día UTC.
3. **Lectura completa antes de publicar.** Leer la tabla real con el handler real y un reloj fijo (solo lectura; el perfil necesita `dynamodb:GetItem` y `dynamodb:Query`):
   ```bash
   AWS_PROFILE=PERFIL_AUTORIZADO AWS_REGION=us-east-1 TRACKS_TABLE_NAME=tracks365-tracks \
     npm run invoke -- GET /api/tracks/today --now=2027-01-01T00:00:00Z
   ```
   Repetir con `/api/tracks/<fecha>` y `/api/tracks?limit=1` (`nextCursor` pagina con `cursor=`).
4. **Frontend.** Desde `http://localhost:4200` contra la URL de la API: cabeceras CORS, lista vacía, cuerpos de error `404`/`400` (`error.code`) y campos opcionales (`coverUrl` y `description` se omiten si no existen). Una canción almacenada se muestra desde la API a partir de las `00:00 UTC` de su fecha.

Usar solo canciones reales con su fecha real, o una claramente de prueba con fecha muy futura (p. ej. `2099-12-31`, nunca pública). Nunca modificar el inicio de la publicación para facilitar las pruebas.

### Limpieza de datos de prueba

No se borra nada automáticamente. Verificá el ítem y eliminalo explícitamente con un perfil autorizado:

```bash
KEY='{"pk":{"S":"TRACK"},"date":{"S":"2099-12-31"}}'
aws --profile PERFIL_AUTORIZADO --region us-east-1 dynamodb get-item --table-name tracks365-tracks --key "$KEY"
aws --profile PERFIL_AUTORIZADO --region us-east-1 dynamodb delete-item --table-name tracks365-tracks --key "$KEY" \
  --condition-expression "attribute_exists(pk)"
```

La tabla tiene recuperación a un punto en el tiempo habilitada.

## Limitaciones conocidas

- El rol `tracks365-cloudformation` puede modificar cualquier API HTTP de la cuenta (`/apis/*`): API Gateway no permite acotar por nombre después de la creación. Se puede acotar al id de la API una vez creada (como hace Foodly).
- Los permisos se derivan de la síntesis local. Si CloudFormation informa un permiso faltante, se ajusta `infra/delivery.ts` y se regeneran los documentos con `npm run admin:policies`.
- Sin alarma ni DLQ para los jobs de catálogo y playlist.
