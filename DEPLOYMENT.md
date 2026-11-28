# Deployment

How to set up and deploy the project. Merging into `main` deploys automatically: that merge is the authorization. Running a workflow by hand is the exception. The repository needs no CDK bootstrap.

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
| `tracks365-secrets`                                                                 | `sync-secrets` workflow (environment `secrets`)  | Writes the Spotify parameters                             |
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
   - `foundation`: required reviewers (it changes IAM roles).
   - `plan`: no reviewers.
   - `production`: no reviewers. Merging the release into `main` is the authorization.
   - `secrets`: no reviewers (its only workflow is manual). `scripts/setup-github-secrets.sh` creates it.

When the roles change (a new role or new permissions), the administrator publishes the regenerated documents before running **foundation**: a new default version of the ceiling, and the foundation CloudFormation role policy.

```bash
aws --profile PERFIL_ADMIN --region us-east-1 iam create-policy-version --set-as-default \
  --policy-arn arn:aws:iam::650387442642:policy/tracks365-ceiling \
  --policy-document file://deploy/admin/tracks365-ceiling.policy.json
aws --profile PERFIL_ADMIN --region us-east-1 iam put-role-policy --role-name tracks365-foundation-cloudformation --policy-name project \
  --policy-document file://deploy/admin/tracks365-foundation-cloudformation.policy.json
```

A managed policy keeps at most five versions: delete the oldest non-default one first if needed (`iam list-policy-versions`, `iam delete-policy-version`). It cannot exceed 6,144 characters without whitespace: `npm run admin:policies` compacts the ceiling without changing its permissions and a test checks the size.

In every command, replace `PERFIL_ADMIN` with a local AWS CLI profile that has the necessary administrative permissions. Before each mutation, verify the identity and check the target account and region:

```bash
aws sts get-caller-identity --profile PERFIL_ADMIN --region us-east-1
```

The account must be `650387442642` and the region `us-east-1`; do not continue otherwise.

## First deployment

Workflows only run from `main`, so a release (`release/x.x.x` → `main`) is needed first.

1. Run the **foundation** workflow and approve the `foundation` environment. It creates the bucket and the eight roles. It stays manual: it changes delivery roles.
2. Merging the release into `main` starts **deploy**. The `plan` job validates, packages, uploads assets and creates the change set (summarized on the run page); the `execute` job executes that same change set with no further approval; the `release` job then publishes the tag and GitHub release `v<package.json version>` if they do not exist yet. **deploy** can also be run by hand from `main`, with the same configuration and no inputs.

The `plan` job stops if the change set touches IAM or removes or replaces the table.

### Role changes before a release

The API stack imports its roles, so a release whose code needs a new role or new permissions must find them already in place. Workflows only run from `main`, which still has the previous release, so an administrator updates the foundation **before** merging that release, from the release branch, with the same template and checks as the workflow (after publishing the regenerated ceiling and policy, see Prerequisites):

```bash
npm ci && npm run synth:foundation
P="--profile PERFIL_ADMIN --region us-east-1"; S=tracks365-foundation; C=admin-$(date +%Y%m%d%H%M%S)
aws $P cloudformation create-change-set --stack-name $S --change-set-name $C --change-set-type UPDATE \
  --template-body file://cdk.foundation.out/Tracks365Foundation.template.json \
  --role-arn arn:aws:iam::650387442642:role/tracks365-foundation-cloudformation --capabilities CAPABILITY_NAMED_IAM
aws $P cloudformation wait change-set-create-complete --stack-name $S --change-set-name $C
aws $P cloudformation describe-change-set --stack-name $S --change-set-name $C \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output table
# Continue only if every change is an AWS::IAM::Role or S3 resource, Add or Modify, with no replacement.
aws $P cloudformation execute-change-set --stack-name $S --change-set-name $C
aws $P cloudformation wait stack-update-complete --stack-name $S
```

Once the release is on `main`, the **foundation** workflow would find nothing to change; it is only needed for the next role change made through `main`.

## Application configuration

Deployment configuration is versioned in [`deploy/production.json`](deploy/production.json):

```json
{
  "corsAllowedOrigins": ["https://daywave.matiasgaleano.dev"],
  "scheduleEnabled": false,
  "playlistScheduleEnabled": false
}
```

- `scheduleEnabled`: daily catalog replenishment (00:00 UTC).
- `playlistScheduleEnabled`: yearly playlist sync (12:30 UTC).

Both schedules are **disabled** in the file. Changing their state, or the CORS list, is a reviewed change to that file that reaches production with the next release; a code deployment never changes them by itself. The workflow passes the values to CDK as context and ignores inherited `PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SCHEDULE_ENABLED` and `PLAYLIST_SYNC_TIME_UTC`. The `plan` job synthesizes once and fails, before creating the change set, if the synthesized state differs from the file; the change set is then prepared from that same verified assembly. The run summary lists each schedule with its state and UTC time. Enable each one only after its credentials exist and a manual run has been verified. The playlist time must be 12:00 UTC or later.

### Credentials (Parameter Store)

Parameter Store is the operational source the backend reads: `SecureString` parameters under `/tracks365`, encrypted with the default `aws/ssm` key (no extra KMS permissions are needed). They are never committed and never reach the frontend. Each Lambda role can read only what it needs:

| Parameter                                      | Content                                              | Read by            | Written by               |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------ | ------------------------ |
| `/tracks365/spotify/client-id`                 | Spotify app client id                                | generate, playlist | `sync-secrets`           |
| `/tracks365/spotify/client-secret`             | Spotify app client secret                            | generate, playlist | `sync-secrets`           |
| `/tracks365/spotify/refresh-token`             | Owner refresh token                                  | playlist           | `sync-secrets`, playlist |
| `/tracks365/spotify/refresh-token-seed-sha256` | SHA-256 of the last refresh token seeded from GitHub | -                  | `sync-secrets`           |
| `/tracks365/openai/api-key`                    | OpenAI API key                                       | generate           | administrator (manual)   |
| `/tracks365/openai/model`                      | OpenAI model name to use (required)                  | generate           | administrator (manual)   |
| `/tracks365/selection/criteria-weights`        | Optional JSON with the six criteria weights          | generate           | administrator (manual)   |

#### Spotify credentials: GitHub Secrets → Parameter Store

The source of the Spotify credentials is the `secrets` environment of the GitHub repository, with three secrets: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_REFRESH_TOKEN`. The manual **sync-secrets** workflow (no inputs, `main` only) assumes `tracks365-secrets` through OIDC and copies them to Parameter Store. That role can only read and write the four Spotify parameters above, and read the refresh token history.

- It validates that all three secrets exist and are not empty before writing anything; it never writes an empty value.
- It is idempotent: it writes only what differs, and prints only parameter names and actions (`created`, `updated`, `unchanged`, `kept-rotated`).
- Spotify can return a new refresh token when the playlist Lambda renews the access token; the Lambda saves it in Parameter Store. The seed parameter keeps the SHA-256 of the last value seeded from GitHub: while `SPOTIFY_REFRESH_TOKEN` does not change, a later sync keeps the rotated token (`kept-rotated`) instead of restoring the old one. A new value in GitHub (a new authorization) is seeded and replaces it; a value that Parameter Store already held in an earlier version (its history) is never restored. The Lambda, in turn, does not save a rotation if the parameter no longer holds the token it started from (a warm instance after a sync or a new authorization).
- Parameter Store has no conditional writes, so do not run **sync-secrets** while the playlist Scheduler may be running.
- Code deployments do not depend on this workflow. It runs for the initial load and after each rotation.

Initial load or rotation, from WSL at the repository root (needs `gh` authenticated with admin access to the repository, Node 24 and `npm ci`):

```bash
bash scripts/setup-github-secrets.sh
```

The script asks for the values without echo and sends them to `gh secret set` through stdin, so nothing stays in the shell history. It creates the `secrets` environment restricted to `main`, can remove the `production` reviewers (only after checking that `main` requires a pull request and restricting `plan` and `production` to `main`), runs the Spotify authorization to obtain a refresh token (or accepts an existing one), and can also seed Parameter Store right away with `AWS_PROFILE=architect`. Then:

```bash
gh workflow run sync-secrets.yml --repo matigaleanodev/365-tracks-api --ref main
```

The OpenAI parameters are still created by hand. The key is read without echo so it stays out of the history:

```bash
bash -c 'read -rs -p "OpenAI API key: " key; echo; [[ -n $key ]] || exit 1
  aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString --overwrite \
    --name /tracks365/openai/api-key --value file:///dev/stdin <<< "$key"'
aws --profile PERFIL_ADMIN --region us-east-1 ssm put-parameter --type SecureString --overwrite \
  --name /tracks365/openai/model --value "<model>"
```

### Spotify Developer setup (manual)

1. With the owner account (Spotify **Premium** is required in Development Mode), create an app in the Spotify Developer Dashboard, select the Web API, and register the redirect URI `http://127.0.0.1:8888/callback` (loopback IP literal; `localhost` is not accepted). The client id and secret are in the app settings.
2. Run `bash scripts/setup-github-secrets.sh` and accept the OAuth authorization. It requests only `playlist-modify-public` and `playlist-read-private` (listing the account playlists to find one by name needs it, even for public ones; in Development Mode `GET /users/{id}/playlists` returns 403), opens a temporary server on `127.0.0.1:8888`, and stores the refresh token in GitHub (and in Parameter Store if requested) without printing it. WSL 2 forwards `127.0.0.1` to the Windows browser.
3. The refresh token can be revoked or expire; the sync then fails with `invalid_grant` and step 2 must be repeated, followed by **sync-secrets**. A token keeps the scopes granted when it was issued: after a scope change, authorize again before the next sync. To authorize again without typing the app credentials: `AWS_PROFILE=architect AWS_REGION=us-east-1 node scripts/spotify-authorize.ts --from-ssm --github-secret --store`.

4. `AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync` is a dry run: it does not modify playlists or sync records, and only days that have ended in every time zone (from 12:00 UTC of D+1) are considered. With a stored playlist record for the year it reads the real playlist and reports what it would add; without a record it does not query Spotify and the result is an upper bound (when writing, an existing playlist with the same name is reused instead of duplicated). Its only possible write is saving to Parameter Store a refresh token that Spotify rotated (needs `ssm:PutParameter`), because discarding it could invalidate the authorization. If that save fails the run aborts (exit code 1). `--write` is the only way to create playlists or add tracks. If the script rotates and saves the token while a playlist Lambda is warm, that instance keeps the previous token until a cold start: do not run the script while the playlist Scheduler may be running.

### Operator tools

Private CLIs with an authorized `AWS_PROFILE`; none is exposed over HTTP and no Lambda role can run them.

- `node scripts/catalog.ts list [--json]`: the whole catalog in date order with status (`published`, `prepared`, `incomplete`), title, artist, Spotify ID, note and dates without a track. Read-only.
- `node scripts/maintenance.ts replace --date=YYYY-MM-DD --file=track.json [--write]`: replaces a track whose date has not started in any time zone (UTC+14), with the same validation and repetition rules as `load-track`. If the new track cannot be saved, it puts the previous one back and reports what the date holds. `remove` refuses the same dates. A published track only accepts `edit-description`; an incomplete track on a started date stays unpublished until fixed by an administrator.
- `node scripts/spotify-check.ts <search|track|verify-catalog> [--market=XX]`: read-only Spotify lookups with the app credentials; `verify-catalog` checks that upcoming Spotify IDs still exist and match.
- `node scripts/playlist.ts info`: authorized account and registered annual playlists with their owner.
- `node scripts/playlist.ts rehearse [--write] [--playlist-id=ID] [--sample=file.json] [--now=ISO]`: runs the real sync against a test playlist owned by the authorized account, with sample tracks in memory. By default it uses the account's public `Daywave - Test` playlist (created with `--write` if missing; annual names are refused), a built-in sample of three well-known songs resolved on Spotify with dates 2027-01-01 to 2027-01-03, and the clock `2027-01-03T12:30:00Z`, so only the first two dates are added. It refuses registered annual playlists, playlists of other owners and samples that contain catalog tracks not yet eligible for a public playlist; with `--write` it runs twice and fails if the second pass adds anything.

### CORS

`corsAllowedOrigins` in `deploy/production.json` is passed to the synth as `CORS_ALLOWED_ORIGINS`. `infra/config.ts` is the single place that validates it:

- Origins as `scheme://host[:port]`, no path or trailing slash; duplicates are ignored.
- `*` is rejected. `https` is required, except `http` for `localhost` / `127.0.0.1`.
- Empty list = no CORS configuration.
- The file holds the **complete** list of production origins: only the public frontend domain. Local frontend development uses fixtures or a local API, not production.

Test with `curl -i -H "Origin: https://<origin>" <api-url>/api/tracks` and look for `access-control-allow-origin`.

## Rollback

Data is never part of a rollback: the table has `DeletionPolicy: Retain` and point-in-time recovery, and no step in this section touches it.

- **A deployment fails.** If the change set fails, CloudFormation returns to the previous template and the `execute` job fails. Before retrying, read the real stack state (`aws --profile AUTHORIZED_PROFILE --region us-east-1 cloudformation describe-stacks --stack-name tracks365-api`): `UPDATE_ROLLBACK_COMPLETE` accepts a new deployment; any other state needs manual review. A workflow that fails after `execute` does not mean production was left unchanged.
- **A released version misbehaves.** The fix is a new `release/x.x.x` to `main` with the fix or a revert; the merge deploys it with the same checks. To stop the editorial jobs, that release keeps `scheduleEnabled` and `playlistScheduleEnabled` at `false`. A revert keeps the published frontend origin in `corsAllowedOrigins` while the frontend uses it, and the configuration test requires it.
- **Required order to revert permissions.** Roles are added, never replaced: an older API version works with a newer foundation, but not the other way around. Revert in this order, each step after the previous one succeeded:
  1. The API, to a version that no longer uses the new roles or permissions (a release; until then CloudFormation needs those permissions to delete the resources that are no longer declared).
  2. The foundation, with a change set of the saved previous template and the same commands as "Role changes before a release". Here the change set may include `Remove` only for roles that the reverted release added and the API no longer uses; no replacements or bucket changes.
  3. The `project` policy of `tracks365-foundation-cloudformation`, with `iam put-role-policy` and the copy saved before the change (the previous one cannot delete the new roles).
  4. The ceiling: `iam list-policy-versions` and `iam set-default-policy-version --version-id vN` on `tracks365-ceiling` (older versions are kept).
- **Stuck rollback.** If a `tracks365-api` rollback ends in `UPDATE_ROLLBACK_FAILED`, an administrator unblocks it with `cloudformation continue-update-rollback --stack-name tracks365-api` (and `--resources-to-skip` only for resources checked by hand); `tracks365-execute` lacks that permission.

## Catalog health signals

Each execution of the replenishment Lambda logs a `catalog-replenish` JSON event (dates and counts only, never titles or artists) and returns the same fields. `status` is one of `catalog-complete`, `progressed`, `stalled-no-time` (too little time left in the invocation: nothing is started and the execution ends without error), `stalled-budget-exhausted` (time ran out before completing any date; the execution fails) and `failed` (a date failed; the execution fails). Also reported: `incompleteCount`, `missingCount`, `preparedAhead` (consecutive complete dates from the start of the window, which is yesterday in UTC) and `runwayLow` (`preparedAhead` below 7).

No alarm resources exist in the stack. Once the schedules are enabled, these conditions should page the owner:

- the Lambda ends with an error (`failed` or `stalled-budget-exhausted`), or `stalled-*` repeats in consecutive executions;
- `runwayLow` is `true`;
- `incompleteCount` is greater than 0 (incomplete dates are never repaired automatically);
- no execution logged `progressed` or `catalog-complete` for a period longer than the schedule interval, or the window shows no progress close to the current date.
