# 365-tracks-api

Backend serverless de **365 Tracks**: una app pública que publica una canción por día, la misma para todos.

[English](README.md)

## Arquitectura

```
Cliente ──► API Gateway (HTTP API) ──► Lambda api ──► DynamoDB
EventBridge Scheduler ──► Lambda generate-daily-track ──► DynamoDB
EventBridge Scheduler ──► Lambda sync-playlist ──► playlist de Spotify
```

- `src/api`: handler HTTP, contratos, errores y paginación.
- `src/tracks`: entidad `DailyTrack`, repositorio y preparación de canciones.
- `src/music-selection`, `src/spotify`, `src/playlist`: selección de canciones, integración con Spotify y playlist anual.
- `src/config`: acceso a Parameter Store. `src/jobs`: handlers programados.
- `infra`: stack CDK `Tracks365ApiStack`.

Una fecha se vuelve pública a las 00:00 de la zona solicitada (`timezone`, IANA, UTC por defecto), nunca antes. La playlist pública anual solo incluye días ya terminados en todas las zonas.

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
npm test               # Vitest (tests unitarios, sin Docker)
npm run test:integration  # repositorio contra DynamoDB Local, ver TESTING.es.md
npm run preview:selection -- --date=AAAA-MM-DD --simulate  # preview de selección, ver TESTING.es.md
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

## Pruebas

Los tests unitarios, las pruebas de integración con DynamoDB Local y el preview de selección están en [TESTING.es.md](TESTING.es.md).

## Despliegue

Prerrequisitos, credenciales y despliegue en [DEPLOYMENT.es.md](DEPLOYMENT.es.md).
