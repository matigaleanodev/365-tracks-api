# Deployment

Guide for the first deployment and later ones. Nothing deploys itself: workflows are manual and the repository needs no CDK bootstrap.

## Model

- Account `650387442642`, region `us-east-1` (fixed in `infra/delivery.ts`).
- Two stacks: **`tracks365-foundation`** (assets bucket and roles) and **`tracks365-api`** (the application).
- The API stack **neither creates nor modifies IAM**: it imports the roles the foundation creates. Assets go to the foundation bucket (`CliCredentialsStackSynthesizer`).
- Every foundation role carries the `tracks365-ceiling` boundary, the union of their permissions, created by an administrator (a prerequisite the pipeline cannot edit).
- GitHub OIDC authentication with an immutable subject (owner and repository id). No long-lived keys and no GitHub variables.

| Role                                                                                | Assumed by                                       | Purpose                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `tracks365-foundation`                                                              | `foundation` workflow (environment `foundation`) | Manages the foundation change set                         |
| `tracks365-foundation-cloudformation`                                               | CloudFormation                                   | Creates the roles (only with the boundary) and the bucket |
| `tracks365-prepare`                                                                 | `plan` job (environment `plan`)                  | Uploads assets and creates the change set                 |
| `tracks365-execute`                                                                 | `execute` job (environment `production`)         | Executes the reviewed change set                          |
| `tracks365-cloudformation`                                                          | CloudFormation                                   | Creates the API resources                                 |
| `tracks365-http`, `tracks365-generate`, `tracks365-playlist`, `tracks365-scheduler` | Lambda / Scheduler                               | Runtime, minimum permissions                              |

## Prerequisites (once, with administrator permissions)

The documents are generated in `deploy/admin/` (`npm run admin:policies` regenerates them; a test checks they are up to date).

1. The `token.actions.githubusercontent.com` OIDC provider in the account (already there if another repo uses it).
2. Managed policy `tracks365-ceiling`:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy --policy-name tracks365-ceiling \
     --policy-document file://deploy/admin/tracks365-ceiling.policy.json
   ```
3. Foundation CloudFormation role:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation-cloudformation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation-cloudformation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
   ```
4. Foundation pipeline role:
   ```bash
   aws --profile PERFIL_ADMIN --region us-east-1 iam create-role --role-name tracks365-foundation \
     --assume-role-policy-document file://deploy/admin/tracks365-foundation.trust.json
   aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation --policy-name project \
     --policy-document file://deploy/admin/tracks365-foundation.policy.json
   ```
5. GitHub environments (Settings → Environments), all restricted to the `main` branch:
   - `foundation`: required reviewers.
   - `plan`: no reviewers.
   - `production`: required reviewers.

In every command, replace `PERFIL_ADMIN` with a local AWS CLI profile that has the necessary administrative permissions. Before each mutation, verify the identity and check the target account and region:

```bash
aws sts get-caller-identity --profile PERFIL_ADMIN --region us-east-1
```

The account must be `650387442642` and the region `us-east-1`; do not continue otherwise.

### Updating an existing installation (new playlist role and Parameter Store permissions)

The ceiling and the foundation CloudFormation policy grew (new `tracks365-playlist` role, Parameter Store and a second schedule). Before running the **foundation** workflow, an administrator must publish the regenerated documents:

```bash
aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy-version --policy-arn arn:aws:iam::650387442642:policy/tracks365-ceiling \
  --policy-document file://deploy/admin/tracks365-ceiling.policy.json --set-as-default
aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
  --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
```

Then run **foundation** (creates the `playlist` role and updates the others) and afterwards **deploy**. A managed policy keeps at most five versions: delete the oldest non-default one first if the limit is reached.

## First deployment

Workflows only run from `main`, so a release (`release/x.x.x` → `main`) is needed first.

1. Run the **foundation** workflow and approve the `foundation` environment. It creates the bucket and the seven roles.
2. Run the **deploy** workflow. The `plan` job validates, packages, uploads assets and creates the change set (summarized on the run page); the `execute` job waits for the `production` environment approval and executes that same change set.

The `plan` job stops if the change set touches IAM or removes or replaces the table.

## Application configuration

`PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SYNC_TIME_UTC` and `PLAYLIST_SCHEDULE_ENABLED` are read at synth time (CDK context or environment variables). The workflow does not set them: with the defaults, **both schedules are disabled**. Enable each one only after its credentials exist and a manual run has been verified. The playlist time must be 12:00 UTC or later.

### Credentials (Parameter Store)

Credentials are `SecureString` parameters under `/tracks365`, encrypted with the default `aws/ssm` key (no extra KMS permissions are needed). They are created by an administrator or the owner, never by the pipeline, and are never committed. Each Lambda role can read only what it needs:

| Parameter                               | Content                                     | Read by            |
| --------------------------------------- | ------------------------------------------- | ------------------ |
| `/tracks365/spotify/client-id`          | Spotify app client id                       | generate, playlist |
| `/tracks365/spotify/client-secret`      | Spotify app client secret                   | generate, playlist |
| `/tracks365/spotify/refresh-token`      | Owner refresh token (written by the script) | playlist (rotates) |
| `/tracks365/openai/api-key`             | OpenAI API key                              | generate           |
| `/tracks365/openai/model`               | OpenAI model name to use (required)         | generate           |
| `/tracks365/selection/criteria-weights` | Optional JSON with the six criteria weights | generate           |

```bash
aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString \
  --name /tracks365/openai/model --value "<model>"        # repeat per parameter; do not paste secrets in shared terminals
```

### Spotify Developer setup (manual)

1. With the owner account (Spotify **Premium** is required in Development Mode), create an app in the Spotify Developer Dashboard and register the redirect URI `http://127.0.0.1:8888/callback` (loopback IP literal; `localhost` is not accepted).
2. Store the client id and secret in Parameter Store as above.
3. Run the one-time authorization from a trusted machine: `SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... AWS_PROFILE=PERFIL_AUTORIZADO node scripts/spotify-authorize.ts --store`. It requests only `playlist-modify-public`, and stores the refresh token without printing it. Without `--store` it only validates the flow.
4. In Development Mode the refresh token can expire (about six months) or be revoked; the sync then fails with `invalid_grant` and step 3 must be repeated.

### Operating the music processes

```bash
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts status                          # read-only
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts replenish --live --write --max-new=3
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync                           # dry run
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync --write
```

`replenish --live` writes future songs to the table and spends OpenAI and Spotify quota; the playlist `--write` creates or modifies a real public playlist. Review the dry run first. Tracks created before descriptions were mandatory are reported as `incomplete` and must be completed (see Manual loading).

### CORS

The **deploy** workflow takes the `cors_allowed_origins` input (default `http://localhost:4200`) and passes it to the synth as `CORS_ALLOWED_ORIGINS`. `infra/config.ts` is the single place that validates it:

- Comma-separated origins (`scheme://host[:port]`, no path or trailing slash); duplicates are ignored.
- `*` is rejected. `https` is required, except `http` for `localhost` / `127.0.0.1`.
- Empty = no CORS configuration.
- Each deployment sets the **complete** list: to add the final frontend domain, run the workflow with `http://localhost:4200,https://<domain>` (and drop localhost once it is no longer needed). The run summary shows the list in effect; the change set shows the API change.

Test with `curl -i -H "Origin: https://<origin>" <api-url>/api/tracks` and look for `access-control-allow-origin`.

## Manual track loading

Until automatic selection exists, tracks are loaded with a CLI (there is no public write endpoint). It reuses `DailyTrack` and `DynamoTrackRepository`: the write is conditional, so an existing date is never overwritten.

```bash
# 1. Validate without touching AWS
node scripts/load-track.ts --file track.json --dry-run
# 2. Write (authorized profile required; ambient credentials are not used)
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/load-track.ts --file track.json
```

`track.json` (`-` reads standard input):

```json
{
  "date": "2027-01-01",
  "title": "…",
  "artist": "…",
  "album": "…",
  "releaseYear": 1991,
  "spotifyTrackId": "<22 characters>",
  "spotifyUrl": "https://open.spotify.com/track/<spotifyTrackId>",
  "selectionCriterion": "…",
  "coverUrl": "https://…",
  "description": "…"
}
```

`coverUrl` and `description` are optional; `createdAt` is set by the CLI; unknown fields are rejected. Dates before the publication start (`2027-01-01`) are rejected. The output is `created` or `already-exists` (with the stored track, which is not modified). The profile needs `dynamodb:PutItem` and `dynamodb:GetItem` on the table; the pipeline roles are not used.

### Preparing several dates (JSON array)

A file holding a JSON **array** of the same objects imports many dates at once (up to 366). Everything is validated before writing:

```bash
node scripts/load-track.ts --file month.json --dry-run
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/load-track.ts --file month.json
```

- Any invalid record, a repeated date or a repeated `spotifyTrackId` inside the file, or a `spotifyTrackId` already stored on another date aborts the whole batch: nothing is written and each record is reported by position and date.
- Dates that already have a track are reported as `already-exists` and are never overwritten, so the same file can be run again safely.
- `--dry-run` only validates the file (it never touches AWS, so stored dates and ids are not checked); the real run also checks the stored catalog and needs `dynamodb:Query` in addition to `GetItem` and `PutItem`.

### Catalog status

```bash
node scripts/catalog.ts status --local                 # in-memory repository, no AWS
AWS_PROFILE=PERFIL_AUTORIZADO node scripts/catalog.ts status   # read-only against the table
```

It prints the 30-date window, how many dates are prepared, which are incomplete and which are missing. `replenish` runs the replenishment (`--local` for tests with stub selection; against the table it also needs `--write`; `--live` uses the real selection). `--now=<ISO instant>` fixes the clock.

## Integration test (Angular → API Gateway → Lambda → DynamoDB)

1. **Load** one real track with the CLI (`--dry-run` first).
2. **Visibility (deployed API).** Before its date, `GET /api/tracks/<date>` must answer `404 TRACK_NOT_FOUND` and `GET /api/tracks` must not list it; `GET /api/tracks/today` answers 404 until a track is published for the UTC day.
3. **Full read path before publication.** Read the real table through the real handler with a fixed clock (read-only; the profile needs `dynamodb:GetItem` and `dynamodb:Query`):
   ```bash
   AWS_PROFILE=PERFIL_AUTORIZADO AWS_REGION=us-east-1 TRACKS_TABLE_NAME=tracks365-tracks \
     npm run invoke -- GET /api/tracks/today --now=2027-01-01T00:00:00Z
   ```
   Repeat for `/api/tracks/<date>` and `/api/tracks?limit=1` (`nextCursor` pages with `cursor=`).
4. **Frontend.** From `http://localhost:4200` against the API URL: CORS headers, empty list, `404`/`400` error bodies (`error.code`) and optional fields (`coverUrl`, `description` are omitted when absent). A stored track renders from the API from `00:00 UTC` of its date.

Use only real tracks with their real date, or a clearly test one with a far-future date (e.g. `2099-12-31`, never public). Never edit the publication start to ease testing.

### Cleaning test data

Nothing is deleted automatically. Check the item and delete it explicitly with an authorized profile:

```bash
KEY='{"pk":{"S":"TRACK"},"date":{"S":"2099-12-31"}}'
aws --profile PERFIL_AUTORIZADO --region us-east-1 dynamodb get-item --table-name tracks365-tracks --key "$KEY"
aws --profile PERFIL_AUTORIZADO --region us-east-1 dynamodb delete-item --table-name tracks365-tracks --key "$KEY" \
  --condition-expression "attribute_exists(pk)"
```

The table has point-in-time recovery enabled.

## Known limitations

- The `tracks365-cloudformation` role can modify any HTTP API in the account (`/apis/*`): API Gateway cannot scope by name after creation. It can be narrowed to the API id once created (as Foodly does).
- Permissions are derived from local synthesis. If CloudFormation reports a missing permission, adjust `infra/delivery.ts` and regenerate the documents with `npm run admin:policies`.
- No alarm or DLQ for the catalog and playlist jobs.
