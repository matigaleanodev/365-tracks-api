# Deployment

Guide for the first deployment and later ones. Nothing deploys itself: workflows are manual and the repository needs no CDK bootstrap.

## Model

- Account `650387442642`, region `us-east-1` (fixed in `infra/delivery.ts`).
- Two stacks: **`tracks365-foundation`** (assets bucket and roles) and **`tracks365-api`** (the application).
- The API stack **neither creates nor modifies IAM**: it imports the roles the foundation creates. Assets go to the foundation bucket (`CliCredentialsStackSynthesizer`).
- Every foundation role carries the `tracks365-ceiling` boundary, the union of their permissions, created by an administrator (a prerequisite the pipeline cannot edit).
- GitHub OIDC authentication with an immutable subject (owner and repository id). No long-lived keys and no GitHub variables.

| Role                                                          | Assumed by                                       | Purpose                                                   |
| ------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `tracks365-foundation`                                        | `foundation` workflow (environment `foundation`) | Manages the foundation change set                         |
| `tracks365-foundation-cloudformation`                         | CloudFormation                                   | Creates the roles (only with the boundary) and the bucket |
| `tracks365-prepare`                                           | `plan` job (environment `plan`)                  | Uploads assets and creates the change set                 |
| `tracks365-execute`                                           | `execute` job (environment `production`)         | Executes the reviewed change set                          |
| `tracks365-cloudformation`                                    | CloudFormation                                   | Creates the API resources                                 |
| `tracks365-http`, `tracks365-generate`, `tracks365-scheduler` | Lambda / Scheduler                               | Runtime, minimum permissions                              |

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

1. Run the **foundation** workflow and approve the `foundation` environment. It creates the bucket and the six roles.
2. Run the **deploy** workflow. The `plan` job validates, packages, uploads assets and creates the change set (summarized on the run page); the `execute` job waits for the `production` environment approval and executes that same change set.

The `plan` job stops if the change set touches IAM or removes or replaces the table.

## Application configuration

`CORS_ALLOWED_ORIGINS`, `PUBLISH_TIME_UTC` and `SCHEDULE_ENABLED` are read at synth time (CDK context or environment variables). The workflow does not set them: with the defaults, **CORS is not configured and the schedule is disabled**. Keep it disabled until the music selector and the Spotify integration exist.

## Known limitations

- The `tracks365-cloudformation` role can modify any HTTP API in the account (`/apis/*`): API Gateway cannot scope by name after creation. It can be narrowed to the API id once created (as Foodly does).
- Permissions are derived from local synthesis. If CloudFormation reports a missing permission, adjust `infra/delivery.ts` and regenerate the documents with `npm run admin:policies`.
- Parameter Store permissions are missing: they are added with the Spotify integration.
- No alarm or DLQ for the daily job.
