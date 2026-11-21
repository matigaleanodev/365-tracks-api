# 365-tracks-api

Backend serverless de **365 Tracks** (nombre técnico provisional): una aplicación pública que publica una canción distinta cada día, igual para todos los visitantes, sin cuentas ni personalización.

[English](README.md)

## Arquitectura

```
Cliente ──► API Gateway (HTTP API) ──► Lambda api ──► DynamoDB (lectura)
EventBridge Scheduler ──► Lambda generate-daily-track ──► DynamoDB (escritura condicional)
                               ├─ music-selection  (puerto, sin implementar)
                               └─ spotify          (puerto, sin implementar)
```

- `src/api`: handler Middy (router + manejo de errores), contratos HTTP y paginación.
- `src/tracks`: entidad `DailyTrack`, puerto `TrackRepository` y caso de uso `generateDailyTrack`.
- `src/music-selection` y `src/spotify`: interfaces de las integraciones futuras; hoy lanzan `NotImplementedError`.
- `src/jobs`: handler del proceso programado.
- `infra`: stack CDK `Tracks365ApiStack`, independiente y agnóstico de cuenta y región.
- La lógica de negocio no importa clientes de AWS ni de terceros; las integraciones entran por interfaces.

### Fecha editorial

La fecha editorial es la fecha del calendario **UTC** (`YYYY-MM-DD`). `GET /api/tracks/today` usa la fecha UTC del instante de la solicitud. Antes de que el proceso diario publique, `today` responde `404 TRACK_NOT_FOUND`.

### Proceso diario idempotente

`generateDailyTrack(date)` consulta primero si la fecha ya tiene canción; si la tiene, no selecciona ni llama a Spotify. La escritura es condicional (`PutItem` con `attribute_not_exists`) y atómica, por lo que dos ejecuciones simultáneas o un reintento nunca generan dos canciones para la misma fecha.

### Modelo de datos

`DailyTrack` separa campos obligatorios (`date`, `title`, `artist`, `album`, `releaseYear`, `spotifyTrackId`, `spotifyUrl`, `selectionCriterion`, `createdAt`) de opcionales (`coverUrl`, `description`). Los opcionales ausentes se omiten del JSON.

Tabla DynamoDB: partition key `pk` (constante) y sort key `date`. Permite `GetItem` por fecha, `Query` ordenado para el historial y escritura condicional. Facturación on-demand, recuperación a un punto en el tiempo y política de retención al eliminar el stack.

## API

API pública, de solo lectura y sin autenticación. Rutas explícitas, sin comodines.

| Método | Ruta                | Descripción                                 |
| ------ | ------------------- | ------------------------------------------- |
| GET    | `/api/tracks/today` | Canción de la fecha UTC actual              |
| GET    | `/api/tracks/:date` | Canción de una fecha (`YYYY-MM-DD`)         |
| GET    | `/api/tracks`       | Historial, más reciente primero, con cursor |

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
| `INVALID_QUERY_PARAMETER` | 400  | `limit` o `cursor` inválidos                 |
| `TRACK_NOT_FOUND`         | 404  | No hay canción para esa fecha                |
| `ROUTE_NOT_FOUND`         | 404  | Ruta o método inexistente                    |
| `INTERNAL_ERROR`          | 500  | Error inesperado (sin detalles internos)     |

Los tipos de los contratos están en `src/api/contracts.ts`.

## Configuración

Ninguna variable contiene secretos. Las credenciales de Spotify y OpenAI nunca llegan al frontend; cuando se integren se resolverán desde un servicio de secretos en el backend.

| Variable (contexto CDK)                       | Default | Descripción                                                                                                         |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS` (`corsAllowedOrigins`) | vacío   | Orígenes permitidos, separados por coma. Vacío = sin CORS. `*` abre la API                                          |
| `PUBLISH_TIME_UTC` (`publishTimeUtc`)         | `00:00` | Hora UTC (`HH:mm`) en que se dispara el proceso diario                                                              |
| `SCHEDULE_ENABLED` (`scheduleEnabled`)        | `false` | Habilita el schedule; mantener en `false` hasta tener selección real                                                |
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

Invoca el handler real con un evento de API Gateway v2 y datos ficticios, sin AWS ni servidor HTTP.

## Despliegue

El stack de la API no crea ni modifica IAM: los roles de Lambda, Scheduler y del pipeline los crea un stack de fundación aparte, bajo una permissions boundary creada por un administrador. Cuenta, región y nombres de recursos están fijos en `infra/delivery.ts`.

El despliegue es manual (workflows `foundation` y `deploy`, OIDC de GitHub, change set con aprobación de entorno). Prerrequisitos y pasos en [DEPLOYMENT.es.md](DEPLOYMENT.es.md); CI solo valida (lint, formato, tipos, tests, build y ambos synth).

## Limitaciones actuales

- El repositorio DynamoDB se probó con un doble del cliente, no contra una tabla real.
- La selección musical y la integración con Spotify no están implementadas; el proceso diario falla de forma explícita si se ejecuta sin ellas.
- Sin integración con OpenAI ni con X/Twitter.
