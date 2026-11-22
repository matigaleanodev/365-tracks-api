# Testing

[Español](TESTING.es.md)

## Unit tests

```bash
npm test
```

Vitest runs everything under `test/` with in-memory repositories and test doubles for DynamoDB, Spotify, OpenAI and Parameter Store. It needs neither Docker nor network access, and it is the suite `npm run check` runs. Files under `test-integration/` are never included.

## Integration tests (DynamoDB Local)

```bash
npm run test:integration
```

Runs the real repository code, with the real AWS SDK clients, against DynamoDB Local in a container, and removes the container afterwards. It is separate from `npm test` and `npm run check`.

Requirements:

- Docker Desktop or Docker Engine. The runner detects `docker` or `docker.exe` on `PATH`; set `DOCKER_BIN` for a binary elsewhere (for example `DOCKER_BIN=/path/to/docker.exe` in WSL without Docker integration).
- Only local Docker daemons are accepted (`unix://` or `npipe://`); `tcp` and `ssh` daemons are rejected.
- Optional `DYNAMODB_LOCAL_ENDPOINT` to use an already running instance. Only loopback endpoints are accepted.

If the runner dies abruptly, leftover containers can be found with `docker ps --filter label=365-tracks-api.integration=true`.

DynamoDB Local is not the managed service: it does not reproduce throttling, latency, capacity limits, IAM or every service behavior. Passing here does not replace the checks in [DEPLOYMENT.md](DEPLOYMENT.md). No AWS account or credentials are used.

## Selection preview

```bash
npm run preview:selection -- --date=YYYY-MM-DD --simulate
npm run preview:selection -- --help
```

Runs the selection path (OpenAI proposes, Spotify resolves, local rules validate) over an in-memory catalog. It persists and publishes nothing. A mode is required: without `--simulate` or `--live` it makes no network call and exits with code 1. Options use the `--flag=value` form only.

| Flag                | Description                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `--date=YYYY-MM-DD` | First date to prepare (default `2027-01-01`)                               |
| `--count=N`         | Consecutive dates, accumulated in memory (1 to 10, default 1)              |
| `--simulate`        | Deterministic simulated HTTP responses: no network, no credentials         |
| `--live`            | Real OpenAI and Spotify calls; only with explicit authorization            |
| `--catalog=FILE`    | JSON array of prepared tracks (`DailyTrack[]`), validated (default: empty) |
| `--budget-ms=N`     | Time budget per date (default 180000)                                      |
| `--json`            | JSON report                                                                |

Exit codes: `0` every date was selected, `2` at least one date has no valid selection, `1` error.

`--live` needs Spotify client credentials (no user account and no playlist scopes) and an OpenAI API key with the chosen model, read from `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `OPENAI_API_KEY` and `OPENAI_MODEL`, plus optional `CRITERIA_WEIGHTS`. It does not need AWS. Set them only in the shell.

The preview does not read the real catalog. To take it into account later, export the catalog to a JSON file in the format above (a read-only export) and pass it with `--catalog`; the preview is never connected to DynamoDB.

The preview must never:

- write to DynamoDB or create `CLAIM` or `ARTIST` records;
- touch playlists, Parameter Store, Schedulers or deployments;
- send Spotify data to OpenAI;
- store credentials or provider responses, or print tokens in logs.

## Remaining risks

Unit tests and the preview cannot guarantee the behavior of the external services: Spotify (search results, quotas, rate limits, token expiry, ambiguous write outcomes), OpenAI (proposals, quota, latency) and AWS (Lambda limits, DynamoDB, IAM, Scheduler). Alert conditions for the catalog are listed in [DEPLOYMENT.md](DEPLOYMENT.md#catalog-health-signals).
