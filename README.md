# 365-tracks-api

Serverless backend for **365 Tracks** (provisional technical name): a public app that publishes a different song every day, the same for every visitor, with no accounts or personalization.

[Español](README.es.md)

## Architecture

```
Client ──► API Gateway (HTTP API) ──► api Lambda ──► DynamoDB (read)
EventBridge Scheduler ──► generate-daily-track Lambda ──► DynamoDB (conditional write)
                               ├─ music-selection  (port, not implemented)
                               └─ spotify          (port, not implemented)
```

- `src/api`: Middy handler (router + error handling), HTTP contracts and pagination.
- `src/tracks`: the `DailyTrack` entity, the `TrackRepository` port and the `generateDailyTrack` use case.
- `src/music-selection` and `src/spotify`: interfaces for future integrations; for now they throw `NotImplementedError`.
- `src/jobs`: scheduled process handler.
- `infra`: CDK stack `Tracks365ApiStack`, independent and account/region agnostic.
- Business logic does not import AWS or third-party clients; integrations enter through interfaces.

### Editorial date

The editorial date is the **UTC** calendar date (`YYYY-MM-DD`). `GET /api/tracks/today` uses the UTC date of the request instant. Before the daily process publishes, `today` returns `404 TRACK_NOT_FOUND`.

### Idempotent daily process

`generateDailyTrack(date)` first checks whether the date already has a track; if so, it neither selects nor calls Spotify. The write is conditional (`PutItem` with `attribute_not_exists`) and atomic, so two concurrent runs or a retry can never produce two tracks for the same date.

### Data model

`DailyTrack` separates required fields (`date`, `title`, `artist`, `album`, `releaseYear`, `spotifyTrackId`, `spotifyUrl`, `selectionCriterion`, `createdAt`) from optional ones (`coverUrl`, `description`). Missing optional fields are omitted from the JSON.

DynamoDB table: partition key `pk` (constant) and sort key `date`. It supports `GetItem` by date, an ordered `Query` for history and the conditional write. On-demand billing, point-in-time recovery and a retain policy on stack deletion.

## API

Public, read-only, unauthenticated API. Explicit routes, no wildcards.

| Method | Path                | Description                             |
| ------ | ------------------- | --------------------------------------- |
| GET    | `/api/tracks/today` | Track for the current UTC date          |
| GET    | `/api/tracks/:date` | Track for a date (`YYYY-MM-DD`)         |
| GET    | `/api/tracks`       | History, newest first, cursor-paginated |

Success responses:

```jsonc
// GET /api/tracks/today, GET /api/tracks/:date
{ "data": { "date": "2027-01-01", "title": "...", "artist": "...", ... } }

// GET /api/tracks?limit=30&cursor=...
{ "data": [ ... ], "pagination": { "limit": 30, "nextCursor": "..." } } // nextCursor is null on the last page
```

`limit` is an integer between 1 and 100 (default 30). `cursor` is opaque: request the next page with the `nextCursor` you received.

Errors always use this shape:

```json
{
  "error": {
    "code": "TRACK_NOT_FOUND",
    "message": "No track published for 2027-01-01",
    "requestId": "..."
  }
}
```

| Code                      | HTTP | When                                   |
| ------------------------- | ---- | -------------------------------------- |
| `INVALID_DATE`            | 400  | `:date` is not a valid calendar date   |
| `INVALID_QUERY_PARAMETER` | 400  | Invalid `limit` or `cursor`            |
| `TRACK_NOT_FOUND`         | 404  | No track for that date                 |
| `ROUTE_NOT_FOUND`         | 404  | Unknown route or method                |
| `INTERNAL_ERROR`          | 500  | Unexpected error (no internal details) |

Contract types live in `src/api/contracts.ts`.

## Configuration

No variable holds a secret. Spotify and OpenAI credentials never reach the frontend; once integrated they will be resolved from a secrets service on the backend.

| Variable (CDK context)                        | Default | Description                                                                                                        |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `CORS_ALLOWED_ORIGINS` (`corsAllowedOrigins`) | empty   | Comma-separated allowed origins. Empty = no CORS. `*` opens the API                                                |
| `PUBLISH_TIME_UTC` (`publishTimeUtc`)         | `00:00` | UTC time (`HH:mm`) at which the daily process fires                                                                |
| `SCHEDULE_ENABLED` (`scheduleEnabled`)        | `false` | Enables the schedule; keep `false` until real selection exists                                                     |
| `USE_DEV_FIXTURES`                            | —       | Local only: `true` serves fictional tracks instead of an empty repository; ignored when `TRACKS_TABLE_NAME` is set |
| `TRACKS_TABLE_NAME`                           | —       | Set by the stack on each Lambda; when present, DynamoDB is used                                                    |

CDK context (`-c key=value`) takes precedence over environment variables. Copy `.env.example` to `.env` (ignored by Git) for local use.

## Requirements

Node.js 24 (see `.nvmrc`) and npm.

## Commands

```bash
npm ci                 # install dependencies
npm run lint           # ESLint
npm run format         # Prettier (writes); format:check only verifies
npm run typecheck      # tsc --noEmit
npm test               # Vitest
npm run build          # bundle each Lambda into dist/ with esbuild
npm run synth          # build + cdk synth (no lookups, no AWS access)
npm run check          # lint + format:check + typecheck + test + synth
```

### Running locally

```bash
npm run invoke -- GET /api/tracks/today
npm run invoke -- GET "/api/tracks?limit=2"
npm run invoke -- GET /api/tracks/2027-02-30
```

Invokes the real handler with an API Gateway v2 event and fictional data, without AWS or an HTTP server.

## Deployment

The stack requires the `RuntimePermissionsBoundaryArn` parameter: the ARN of a previously created permissions boundary, applied to every role in the stack and not provisioned by it. Lambda roles only write to their own log group and use the minimum table actions. Example: `--parameters RuntimePermissionsBoundaryArn=arn:aws:iam::<account>:policy/<boundary>`.

The stack is not deployed from this repository yet: CI only validates (lint, format, types, tests, build and synth). A deployment needs credentials and an account/region chosen by whoever deploys, for example `npx cdk deploy --profile PROFILE` after `npm run build`.

## Current limitations

- The DynamoDB repository has been tested against a client double, not a real table.
- Music selection and the Spotify integration are not implemented; the daily process fails explicitly if run without them.
- No OpenAI or X/Twitter integration.
