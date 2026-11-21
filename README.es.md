# 365-tracks-api

Backend serverless de **365 Tracks** (nombre técnico provisional): una aplicación pública que publica una canción distinta cada día, igual para todos los visitantes, sin cuentas ni personalización.

[English](README.md)

## Arquitectura

```
Cliente ──► API Gateway (HTTP API) ──► Lambda api ──► DynamoDB (lectura)
EventBridge Scheduler ──► Lambda generate-daily-track ──► DynamoDB (escritura condicional)
                               ├─ music-selection  (OpenAI propone, Spotify resuelve)
                               └─ spotify          (cliente del catálogo)
EventBridge Scheduler ──► Lambda sync-playlist ──► playlist de Spotify + DynamoDB (estado de sincronización)
```

- `src/api`: handler Middy (router + manejo de errores), contratos HTTP y paginación.
- `src/tracks`: entidad `DailyTrack`, puerto `TrackRepository` , caso de uso `generateDailyTrack` y ventana del catálogo (`catalog.ts`).
- `src/music-selection`: selector editorial (criterios, diversidad, reglas de repetición, proponente de OpenAI). `src/spotify`: cliente del catálogo, coincidencias, autorización del dueño y cliente de playlists. `src/playlist`: corte de elegibilidad y sincronización idempotente. `src/config`: acceso a Parameter Store.
- `src/jobs`: handlers de reposición del catálogo y de sincronización de la playlist.
- `infra`: stack CDK `Tracks365ApiStack`, independiente y agnóstico de cuenta y región.
- La lógica de negocio no importa clientes de AWS ni de terceros; las integraciones entran por interfaces.

### Fecha editorial

La fecha editorial (`YYYY-MM-DD`) identifica a cada canción y la zona horaria del visitante nunca la modifica: todos comparten la misma canción para cada fecha. Lo que depende de la zona horaria es _cuándo_ una fecha se hace visible (ver Visibilidad pública).

### Visibilidad pública

La API pública solo expone canciones publicadas: las de una fecha que ya comenzó en la zona horaria solicitada y que no es anterior al inicio de la publicación, `2027-01-01` (`src/tracks/publication.ts`). La fecha local se calcula con el **reloj del servidor** y el parámetro `timezone` (nombre IANA, p. ej. `America/Argentina/Buenos_Aires`); nunca se usa la fecha enviada por el navegador. Sin `timezone` rige UTC. Así, cada fecha abre a las 00:00 locales de cada zona.

Una canción guardada por adelantado no se ve hasta que su fecha empieza en la zona de quien consulta: `GET /api/tracks/:date` responde `404 TRACK_NOT_FOUND` igual que una fecha sin canción, y el historial nunca la lista ni un cursor llega hasta ella (el cursor se acota al "mañana" local de quien consulta).

Las respuestas llevan `Cache-Control: private, no-cache`: lo visible depende de la zona y del instante, por lo que ninguna caché compartida puede reutilizar una respuesta entre visitantes. Un CDN delante de la API debe incluir `timezone` en su clave de caché.

### Ventana del catálogo

Las canciones se preparan por adelantado en la misma tabla: un ítem por fecha, y las futuras quedan ocultas por la regla anterior. El catálogo mantiene una ventana móvil de 30 fechas (`src/tracks/catalog.ts`) que empieza en la fecha UTC de ayer (la zona más atrasada, UTC-12, todavía vive ahí) y nunca antes del inicio de la publicación. La zona más adelantada (UTC+14) ya está un día por delante de UTC, así que la ventana conserva siempre más de tres semanas de reserva más allá de ella.

`replenishCatalog` detecta las fechas sin canción y completa solo esas con `generateDailyTrack`, en orden de fecha y deteniéndose en el primer fallo para reintentar el resto en la siguiente ejecución. Nunca reescribe una fecha preparada. Nunca se escribe una canción con un campo obligatorio vacío o con una descripción inválida; esa fecha no queda preparada. Una canción existente pero incompleta se informa (`incomplete`) y se deja para corregir a mano.

Cada ejecución es acotada: como máximo `CATALOG_MAX_NEW_PER_RUN` fechas nuevas (por defecto 5) y deja de empezar fechas cuando a la Lambda le quedan menos de 90 s. El resto se informa como `deferred` y se retoma en la siguiente ejecución, porque el estado es el propio catálogo. Los logs llevan fechas y conteos, nunca títulos ni artistas.

### Selección musical

Para cada fecha faltante, el selector ordena los criterios editoriales según cuánto se aleja el catálogo de la distribución objetivo (`classic` 20%, `hidden-gem` 25%, `music-anniversary` 20%, `genre-exploration` 15%, `recent-release` 10%, `cultural-date` 10%; son objetivos, no probabilidades; configurables). OpenAI solo propone candidatos (título, artista, año, descripción breve) a partir de instrucciones editoriales y objetivos blandos de década, región y género derivados de la fecha. **Nunca se envían datos de Spotify a OpenAI.**

Todo lo demás es local. Spotify resuelve cada candidato; las coincidencias dudosas (otro artista, otra versión, álbum en vivo, perfiles de artista ambiguos, año con más de uno de diferencia) se rechazan. También se rechaza un candidato si su ID de Spotify o su grabación (título base + artista) ya están en el catálogo, pasado o futuro, o si su artista principal (por ID de Spotify o nombre normalizado) aparece dentro de los 60 días hacia cualquier lado. Una efeméride se acepta solo si Spotify informa el día exacto y coincide con el mes y día de la fecha. La descripción (obligatoria, de 40 a 500 caracteres, un párrafo, sin enlaces, comillas, nombres de mes ni años sin verificar) la produce el modelo sin datos de Spotify y se valida localmente. Si no aparece una canción válida dentro de los límites de rondas, la fecha falla informando solo conteos por motivo.

### Playlist

La playlist pública anual (`365 Tracks <año>`) pertenece a una única cuenta de Spotify y contiene solo días que ya terminaron en todas las zonas horarias: la canción de la fecha D es elegible desde las 12:00 UTC de D+1. `sync-playlist` corre independiente de la preparación, lee la playlist real antes de escribir (adopta lo que una ejecución anterior ya agregó, sin duplicar), agrega en orden cronológico y registra el resultado en DynamoDB. Un año nuevo usa una playlist nueva. La autorización del dueño en Spotify se hace una vez con `scripts/spotify-authorize.ts`.

### Generación idempotente

`generateDailyTrack(date)` consulta primero si la fecha ya tiene canción; si la tiene, no selecciona ni llama a Spotify. La escritura es condicional (`PutItem` con `attribute_not_exists`) y atómica, por lo que dos ejecuciones simultáneas o un reintento nunca generan dos canciones para la misma fecha.

### Modelo de datos

`DailyTrack` separa campos obligatorios (`date`, `title`, `artist`, `album`, `releaseYear`, `spotifyTrackId`, `spotifyUrl`, `selectionCriterion`, `createdAt`) de opcionales (`coverUrl`). `description` es obligatoria para que una canción cuente como preparada pero opcional en el contrato HTTP, y `spotifyArtistId` es interno y nunca se devuelve. Los opcionales ausentes se omiten del JSON.

Tabla DynamoDB: partition key `pk` (constante) y sort key `date`. Permite `GetItem` por fecha, `Query` ordenado para el historial y escritura condicional. Facturación on-demand, recuperación a un punto en el tiempo y política de retención al eliminar el stack.

## API

API pública, de solo lectura y sin autenticación. Rutas explícitas, sin comodines.

| Método | Ruta                | Descripción                                 |
| ------ | ------------------- | ------------------------------------------- |
| GET    | `/api/tracks/today` | Canción de hoy en la zona solicitada        |
| GET    | `/api/tracks/:date` | Canción de una fecha (`YYYY-MM-DD`)         |
| GET    | `/api/tracks`       | Historial, más reciente primero, con cursor |

Todas las rutas aceptan `timezone` (opcional): un nombre de zona IANA como `Europe/Madrid`. Sin él rige `UTC`. Define qué fechas ya son públicas para quien consulta: `today` es su fecha local y ni la consulta directa, ni el historial, ni un cursor devuelven una fecha posterior. Se rechazan con `INVALID_QUERY_PARAMETER` los desplazamientos como `+03:00`, las zonas desconocidas y el valor vacío.

Respuestas exitosas:

```jsonc
// GET /api/tracks/today, GET /api/tracks/:date
{ "data": { "date": "2027-01-01", "title": "...", "artist": "...", ... } }

// GET /api/tracks?limit=30&cursor=...
{ "data": [ ... ], "pagination": { "limit": 30, "nextCursor": "..." } } // nextCursor es null en la última página
```

`limit` es un entero entre 1 y 100 (por defecto 30). `cursor` es un valor opaco: se pide la página siguiente con el `nextCursor` recibido.

Errores, siempre con este formato:

```json
{
  "error": {
    "code": "TRACK_NOT_FOUND",
    "message": "No track published for 2027-01-01",
    "requestId": "..."
  }
}
```

| Código                    | HTTP | Cuándo                                       |
| ------------------------- | ---- | -------------------------------------------- |
| `INVALID_DATE`            | 400  | `:date` no es una fecha de calendario válida |
| `INVALID_QUERY_PARAMETER` | 400  | `limit`, `cursor` o `timezone` inválidos     |
| `TRACK_NOT_FOUND`         | 404  | No hay canción para esa fecha                |
| `ROUTE_NOT_FOUND`         | 404  | Ruta o método inexistente                    |
| `INTERNAL_ERROR`          | 500  | Error inesperado (sin detalles internos)     |

Los tipos de los contratos están en `src/api/contracts.ts`.

## Configuración

Ninguna variable contiene secretos. Las credenciales de Spotify y OpenAI viven en Parameter Store (SecureString, prefijo `/tracks365`) y solo las leen las Lambdas del backend; ver [DEPLOYMENT.es.md](DEPLOYMENT.es.md).

| Variable (contexto CDK)                       | Default | Descripción                                                                                                         |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS` (`corsAllowedOrigins`) | vacío   | Orígenes permitidos, separados por coma. Vacío = sin CORS. Se rechaza `*`; solo `https` (`http` para localhost)     |
| `PUBLISH_TIME_UTC` (`publishTimeUtc`)         | `00:00` | Hora UTC (`HH:mm`) en que se dispara el proceso diario                                                              |
| `SCHEDULE_ENABLED` (`scheduleEnabled`)        | `false` | Habilita el schedule de reposición del catálogo                                                                     |
| `PLAYLIST_SYNC_TIME_UTC`                      | `12:30` | Hora UTC de la sincronización de la playlist; debe ser 12:00 o posterior                                            |
| `PLAYLIST_SCHEDULE_ENABLED`                   | `false` | Habilita el schedule de la playlist, independiente del anterior                                                     |
| `USE_DEV_FIXTURES`                            | —       | Solo local: `true` sirve canciones ficticias en lugar de un repositorio vacío; se ignora si hay `TRACKS_TABLE_NAME` |
| `TRACKS_TABLE_NAME`                           | —       | La define el stack en cada Lambda; con ella se usa DynamoDB                                                         |

El contexto de CDK (`-c clave=valor`) tiene prioridad sobre las variables de entorno. Copiar `.env.example` a `.env` (ignorado por Git) para uso local.

## Requisitos

Node.js 24 (ver `.nvmrc`) y npm.

## Comandos

```bash
npm ci                 # instalar dependencias
npm run lint           # ESLint
npm run format         # Prettier (escribe); format:check solo verifica
npm run typecheck      # tsc --noEmit
npm test               # Vitest
npm run build          # empaqueta cada Lambda en dist/ con esbuild
npm run synth          # build + cdk synth (sin lookups ni acceso a AWS)
npm run check          # lint + format:check + typecheck + test + synth
```

### Ejecución local

```bash
npm run invoke -- GET /api/tracks/today
npm run invoke -- GET "/api/tracks?limit=2"
npm run invoke -- GET /api/tracks/2027-02-30
```

Invoca el handler real con un evento de API Gateway v2 y datos ficticios, sin AWS ni servidor HTTP. `--now=<instante ISO>` fija el reloj del handler (solo local).

Las canciones se cargan a mano con `node scripts/load-track.ts` (una canción o un array JSON; ver `DEPLOYMENT.es.md`). `node scripts/catalog.ts status --local` muestra la ventana del catálogo sobre un repositorio en memoria vacío. `scripts/catalog.ts replenish --live --write` y `scripts/playlist.ts sync [--write]` operan sobre los recursos desplegados y necesitan `AWS_PROFILE`; la sincronización de la playlist es una simulación salvo que se pase `--write`. La API pública es de solo lectura.

## Despliegue

El stack de la API no crea ni modifica IAM: los roles de Lambda, Scheduler y del pipeline los crea un stack de fundación aparte, bajo una permissions boundary creada por un administrador. Cuenta, región y nombres de recursos están fijos en `infra/delivery.ts`.

El despliegue es manual (workflows `foundation` y `deploy`, OIDC de GitHub, change set con aprobación de entorno). Prerrequisitos y pasos en [DEPLOYMENT.es.md](DEPLOYMENT.es.md); CI solo valida (lint, formato, tipos, tests, build y ambos synth).

## Limitaciones actuales

- El repositorio DynamoDB se probó con un doble del cliente, no contra una tabla real.
- OpenAI, Spotify y la playlist se probaron contra dobles, no contra los servicios reales.
- Las canciones guardadas sin una descripción válida cuentan como incompletas y hay que completarlas a mano.
- Sin integración con X/Twitter.
