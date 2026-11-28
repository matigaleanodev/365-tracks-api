# 365-tracks-api

[![CI](https://img.shields.io/github/actions/workflow/status/matigaleanodev/365-tracks-api/ci.yml?style=flat-square&label=CI)](https://github.com/matigaleanodev/365-tracks-api/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-24-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&logo=typescript&logoColor=white)
![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-FF9900?style=flat-square&logo=awslambda&logoColor=white)
![AWS CDK](https://img.shields.io/badge/AWS_CDK-2-FF9900?style=flat-square&logo=amazonwebservices&logoColor=white)
![DynamoDB](https://img.shields.io/badge/DynamoDB-4053D6?style=flat-square&logo=amazondynamodb&logoColor=white)

Serverless backend for **365 Tracks**: a public app that publishes one song per day, the same for every visitor.

[Español](README.es.md)

## Architecture

```
Client ──► API Gateway (HTTP API) ──► api Lambda ──► DynamoDB
EventBridge Scheduler ──► generate-daily-track Lambda ──► DynamoDB
EventBridge Scheduler ──► sync-playlist Lambda ──► Spotify playlist
```

- `src/api`: HTTP handler, contracts, errors and pagination.
- `src/tracks`: `DailyTrack` entity, repository and track preparation.
- `src/music-selection`, `src/spotify`, `src/playlist`: track selection, Spotify integration and the annual playlist.
- `src/config`: Parameter Store access. `src/jobs`: scheduled handlers.
- `infra`: CDK stack `Tracks365ApiStack`.

A date becomes public at 00:00 in the requested time zone (`timezone`, IANA, UTC by default), never earlier. The annual public playlist only includes days that have ended in every time zone.

## API

Public, read-only, unauthenticated API. Explicit routes, no wildcards.

| Method | Path                | Description                             |
| ------ | ------------------- | --------------------------------------- |
| GET    | `/api/tracks/today` | Track for today in the requested zone   |
| GET    | `/api/tracks/:date` | Track for a date (`YYYY-MM-DD`)         |
| GET    | `/api/tracks`       | History, newest first, cursor-paginated |

All routes accept `timezone` (optional): an IANA time zone name such as `Europe/Madrid`. It defaults to `UTC` when omitted. It decides which dates are already public for that caller, so `today` is the caller's local date and neither a direct query, the history nor a cursor ever returns a later date. Offsets such as `+03:00`, unknown zones and an empty value are rejected with `INVALID_QUERY_PARAMETER`.

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

| Code                      | HTTP | When                                    |
| ------------------------- | ---- | --------------------------------------- |
| `INVALID_DATE`            | 400  | `:date` is not a valid calendar date    |
| `INVALID_QUERY_PARAMETER` | 400  | Invalid `limit`, `cursor` or `timezone` |
| `TRACK_NOT_FOUND`         | 404  | No track for that date                  |
| `ROUTE_NOT_FOUND`         | 404  | Unknown route or method                 |
| `INTERNAL_ERROR`          | 500  | Unexpected error (no internal details)  |

Contract types live in `src/api/contracts.ts`.

## Configuration

No variable holds a secret. Spotify and OpenAI credentials live in Parameter Store (SecureString, prefix `/tracks365`) and are read only by the backend Lambdas; see [DEPLOYMENT.md](DEPLOYMENT.md).

| Variable (CDK context)                        | Default | Description                                                                                                        |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `CORS_ALLOWED_ORIGINS` (`corsAllowedOrigins`) | empty   | Comma-separated allowed origins. Empty = no CORS. `*` is rejected; `https` only (`http` for localhost)             |
| `PUBLISH_TIME_UTC` (`publishTimeUtc`)         | `00:00` | UTC time (`HH:mm`) at which the daily process fires                                                                |
| `SCHEDULE_ENABLED` (`scheduleEnabled`)        | `false` | Enables the catalog replenishment schedule                                                                         |
| `PLAYLIST_SYNC_TIME_UTC`                      | `12:30` | UTC time of the playlist sync; must be 12:00 or later                                                              |
| `PLAYLIST_SCHEDULE_ENABLED`                   | `false` | Enables the playlist sync schedule, independent of the one above                                                   |
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
npm test               # Vitest (unit tests, no Docker)
npm run test:integration  # repository against DynamoDB Local, see TESTING.md
npm run preview:selection -- --date=YYYY-MM-DD --simulate  # selection preview, see TESTING.md
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

Invokes the real handler with an API Gateway v2 event and fictional data, without AWS or an HTTP server. `--now=<ISO instant>` fixes the handler clock (local only).

## Testing

Unit tests, DynamoDB Local integration tests and the selection preview are described in [TESTING.md](TESTING.md).

## Deployment

Prerequisites, credentials and deployment are in [DEPLOYMENT.md](DEPLOYMENT.md).
