# Deployment

How to set up and deploy the project. Workflows are manual and the repository needs no CDK bootstrap.

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

## First deployment

Workflows only run from `main`, so a release (`release/x.x.x` → `main`) is needed first.

1. Run the **foundation** workflow and approve the `foundation` environment. It creates the bucket and the seven roles.
2. Run the **deploy** workflow. The `plan` job validates, packages, uploads assets and creates the change set (summarized on the run page); the `execute` job waits for the `production` environment approval and executes that same change set.

The `plan` job stops if the change set touches IAM or removes or replaces the table.

## Application configuration

`PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SYNC_TIME_UTC` and `PLAYLIST_SCHEDULE_ENABLED` are read at synth time (CDK context, then environment variables, then defaults). The **deploy** workflow controls the two schedules with boolean inputs, both unchecked by default:

- `schedule_enabled`: daily catalog replenishment (00:00 UTC).
- `playlist_schedule_enabled`: yearly playlist sync (12:30 UTC).

By default **both schedules are disabled**. Each deployment sets their state explicitly (the workflow passes them to CDK as context and ignores inherited `PUBLISH_TIME_UTC`, `SCHEDULE_ENABLED`, `PLAYLIST_SCHEDULE_ENABLED` and `PLAYLIST_SYNC_TIME_UTC`), so a later deployment with the inputs unchecked disables them again. The `plan` job synthesizes once and fails, before creating the change set, if the synthesized state differs from the inputs; the change set is then prepared from that same verified assembly. The run summary lists each schedule with its state and UTC time. Enable each one only after its credentials exist and a manual run has been verified. The playlist time must be 12:00 UTC or later.

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
5. `AWS_PROFILE=PERFIL_AUTORIZADO node scripts/playlist.ts sync` is a dry run: it does not modify playlists or sync records, and only days that have ended in every time zone (from 12:00 UTC of D+1) are considered. With a stored playlist record for the year it reads the real playlist and reports what it would add; without a record it does not query Spotify and the result is an upper bound (when writing, an existing playlist with the same name is reused instead of duplicated). Its only possible write is saving to Parameter Store a refresh token that Spotify rotated (needs `ssm:PutParameter`), because discarding it could invalidate the authorization. If that save fails the run aborts (exit code 1). `--write` is the only way to create playlists or add tracks. If the script rotates and saves the token while a playlist Lambda is warm, that instance keeps the previous token until a cold start: do not run the script while the playlist Scheduler may be running.

### CORS

The **deploy** workflow takes the `cors_allowed_origins` input (default `http://localhost:4200`) and passes it to the synth as `CORS_ALLOWED_ORIGINS`. `infra/config.ts` is the single place that validates it:

- Comma-separated origins (`scheme://host[:port]`, no path or trailing slash); duplicates are ignored.
- `*` is rejected. `https` is required, except `http` for `localhost` / `127.0.0.1`.
- Empty = no CORS configuration.
- Each deployment sets the **complete** list: to add the final frontend domain, run the workflow with `http://localhost:4200,https://<domain>` (and drop localhost once it is no longer needed). The run summary shows the list in effect; the change set shows the API change.

Test with `curl -i -H "Origin: https://<origin>" <api-url>/api/tracks` and look for `access-control-allow-origin`.
