# 365-tracks-api

Serverless backend for **365 Tracks** (provisional technical name): a public app that publishes a different song every day, the same for every visitor, with no accounts or personalization.

[Español](README.es.md)

## Architecture

```
Client ──► API Gateway (HTTP API) ──► api Lambda ──► DynamoDB (read)
EventBridge Scheduler ──► generate-daily-track Lambda ──► DynamoDB (conditional write)
                               ├─ music-selection  (OpenAI proposes, Spotify resolves)
                               └─ spotify          (catalog client)
EventBridge Scheduler ──► sync-playlist Lambda ──► Spotify playlist + DynamoDB (sync state)
```

- `src/api`: Middy handler (router + error handling), HTTP contracts and pagination.
- `src/tracks`: the `DailyTrack` entity, the `TrackRepository` port and the `generateDailyTrack` use case and the catalog window (`catalog.ts`).
- `src/music-selection`: editorial selector (criteria, diversity, repetition rules, OpenAI proposer). `src/spotify`: catalog client, matching, owner authorization and playlist client. `src/playlist`: eligibility cutoff and idempotent sync. `src/config`: Parameter Store access.
- `src/jobs`: handlers for catalog replenishment and playlist sync.
- `infra`: CDK stack `Tracks365ApiStack`, independent and account/region agnostic.
- Business logic does not import AWS or third-party clients; integrations enter through interfaces.

### Editorial date

The editorial date (`YYYY-MM-DD`) identifies each track and is never changed by the visitor's time zone: every visitor shares the same track for each date. What depends on the time zone is _when_ a date becomes visible (see Public visibility).

### Public visibility

The public API only exposes published tracks: those whose date has already begun in the requested time zone and is not before the publication start, `2027-01-01` (`src/tracks/publication.ts`). The local date is derived from the **server clock** and the `timezone` query parameter (IANA name, e.g. `America/Argentina/Buenos_Aires`); the date sent by a browser is never used. Without `timezone`, UTC applies. A date therefore opens at 00:00 local time in each zone.

A track stored ahead of time is invisible until its date begins in the caller's zone: `GET /api/tracks/:date` answers `404 TRACK_NOT_FOUND` as for a date without a track, and the history never lists it, nor does a cursor reach it (a cursor is capped at the caller's local tomorrow).

Responses carry `Cache-Control: private, no-cache`: what is visible depends on the zone and the instant, so no shared cache may reuse a response across visitors. A CDN placed in front must include `timezone` in its cache key.

### Catalog window

Tracks are prepared ahead of time in the same table: one item per date, future ones hidden by the rule above. The catalog keeps a moving window of 30 dates (`src/tracks/catalog.ts`), starting at the UTC date of yesterday (the lagging zone, UTC-12, still lives there) and never before the publication start. The leading zone (UTC+14) is already one day ahead of UTC, so the window always holds well over three weeks of reserve beyond it.

`replenishCatalog` finds the dates without a track and completes only those through `generateDailyTrack`, in date order, stopping at the first failure so the rest is retried on the next run. It never rewrites a prepared date. A track is never written if a required field is empty or its description is invalid; such a date is not prepared. An existing but incomplete track is reported (`incomplete`) and left for manual fixing.

Each run is bounded: at most `CATALOG_MAX_NEW_PER_RUN` new dates (default 5) and it stops starting dates when the Lambda has under 90 s left. The rest is reported as `deferred` and resumed on the next run, since the catalog itself is the state. Logs carry dates and counts, never titles or artists.

### Music selection

For each missing date the selector ranks the editorial criteria by how far the catalog is from the target distribution (`classic` 20%, `hidden-gem` 25%, `music-anniversary` 20%, `genre-exploration` 15%, `recent-release` 10%, `cultural-date` 10%; targets, not probabilities; configurable). OpenAI only proposes candidates (title, artist, year, short description) from editorial instructions plus soft decade/region/genre targets derived from the date. **No Spotify data is ever sent to OpenAI.**

Everything else is local. Spotify resolves each candidate; doubtful matches (other artist, other version, live album, ambiguous artist profiles, year off by more than one) are rejected. A candidate is also rejected if its Spotify ID or its recording (core title + artist) is already in the catalog, past or future, or if its main artist (by Spotify ID or normalized name) appears within 60 days either side. An anniversary is accepted only if Spotify reports the exact day, matching the date's month and day. The description (mandatory, 40–500 characters, one paragraph, no links, quotes, month names or unverified years) is produced by the model without Spotify data and validated locally. If no valid song is found within the round limits the date fails with reason counts only.

### Playlist

The public annual playlist (`365 Tracks <year>`) is owned by a single Spotify account and contains only days that have ended in every time zone: the song of date D is eligible from 12:00 UTC of D+1. `sync-playlist` runs independently of preparation, reads the real playlist before writing (adopting songs a previous run already added, never duplicating), adds in chronological order and records the result in DynamoDB. A new year gets a new playlist. Spotify owner authorization is done once with `scripts/spotify-authorize.ts`.

### Idempotent generation

`generateDailyTrack(date)` first checks whether the date already has a track; if so, it neither selects nor calls Spotify. The write is conditional (`PutItem` with `attribute_not_exists`) and atomic, so two concurrent runs or a retry can never produce two tracks for the same date.

### Data model

`DailyTrack` separates required fields (`date`, `title`, `artist`, `album`, `releaseYear`, `spotifyTrackId`, `spotifyUrl`, `selectionCriterion`, `createdAt`) from optional ones (`coverUrl`). `description` is mandatory for a track to count as prepared but optional in the HTTP contract, and `spotifyArtistId` is internal and never returned. Missing optional fields are omitted from the JSON.

DynamoDB table: partition key `pk` (constant) and sort key `date`. It supports `GetItem` by date, an ordered `Query` for history and the conditional write. On-demand billing, point-in-time recovery and a retain policy on stack deletion.

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

Invokes the real handler with an API Gateway v2 event and fictional data, without AWS or an HTTP server. `--now=<ISO instant>` fixes the handler clock (local only).

Tracks are loaded manually with `node scripts/load-track.ts` (one track or a JSON array; see `DEPLOYMENT.md`). `node scripts/catalog.ts status --local` shows the catalog window against an empty in-memory repository. `scripts/catalog.ts replenish --live --write` and `scripts/playlist.ts sync [--write]` operate on the deployed resources and need `AWS_PROFILE`; the playlist sync is a dry run unless `--write` is given. The public API is read-only.

## Deployment

The API stack neither creates nor modifies IAM: Lambda and Scheduler roles and the pipeline roles are created by a separate foundation stack, under a permissions boundary created by an administrator. Account, region and resource names are fixed in `infra/delivery.ts`.

Deployment is manual (`foundation` and `deploy` workflows, GitHub OIDC, change set with environment approval). Prerequisites and steps are in [DEPLOYMENT.md](DEPLOYMENT.md); CI only validates (lint, format, types, tests, build and both synths).

## Current limitations

- The DynamoDB repository has been tested against a client double, not a real table.
- OpenAI, Spotify and the playlist have been tested against doubles, not the real services.
- Tracks stored without a valid description count as incomplete and must be completed manually.
- No X/Twitter integration.
