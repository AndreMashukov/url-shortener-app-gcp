# Difficulties Encountered: GCP URL Shortener Build

A working log of the non-obvious failures, surprises, and dead ends hit while porting the AWS `url-shortener-app` to GCP using the `gcp-terraform-cloud-run` skill. Intended as a reference for future projects.

## Environment quirks

### 1. `gcloud` needs the bearer-token pattern in this container

The container has no interactive OAuth. The trick:

```bash
export CLOUDSDK_AUTH_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)
```

This is **per-process**. The token has a ~1 hour TTL. Long sessions need to refresh it.

### 2. ADC quota project is a dead end

`gcloud auth set-quota-project` tries to edit the ADC file, which is read-only in this container. Workaround: set `GOOGLE_CLOUD_PROJECT` env var per shell. Only `google_identity_platform_config.default` actually needs the quota project — every other Terraform resource works without it.

### 3. Docker is not really Docker

`docker` is in `$PATH` but the binary is `docker-cli` only — no `dockerd`, no socket. The container does not have root, so `apt install docker.io` is out.

**Workaround:** `gcloud builds submit` with a real `Dockerfile` and `gcr.io/cloud-builders/docker` as the build step. No Docker daemon needed locally.

Caveats:
- Buildpacks (`gcloud builds submit --pack`) work in theory but `BP_NODE_PROJECT_PATH` is silently ignored for monorepo subprojects — the buildpack looks for `/workspace/index.js` instead. Multi-stage Dockerfile is the right tool here.
- Build context must include `node_modules` (or the Dockerfile must `npm ci`). `gcloudignore` excludes a lot by default; the `--config` approach to Cloud Build gives more control.

### 4. `yarn` is not installed

The skill's example repo uses yarn workspaces. Switched to **npm workspaces** (Node 22 native). `workspace:*` protocol doesn't work — use `file:../libs/...`.

## Terraform gotchas

### 5. Cloud Run "needs update" loop on every apply

After the first partial apply, every subsequent `terraform plan` reported Cloud Run services as needing updates due to cosmetic drift: `labels`, `terraform_labels`, `scaling`, `deletion_protection`, `template[0].scaling`. Re-applying timed out because the live services were `CONDITION_FAILED` and Cloud Run could not put them back into a "ready" state.

**Fix:** add `lifecycle.ignore_changes` to `google_cloud_run_v2_service`. This is a real anti-pattern in general but is the correct escape hatch when GCP mutates the resource out-of-band (region init, autoscaler).

### 6. State-lock deadlock after killed apply

`Ctrl-C` on a `terraform apply` leaves a lock in the GCS backend. The next apply errors with `Error acquiring the state lock`. The fix is `terraform force-unlock <lock-id>`. The lock-id is a long hex string in the error message. Plan for one extra command per killed run.

### 7. Importing failed resources

`terraform import` on a `google_cloud_run_v2_service` requires the full path `projects/P/locations/L/services/S`. Once imported, combine with `ignore_changes` before re-applying, or you loop forever.

### 8. Eventarc Pub/Sub `matching_criteria` is locked

For Pub/Sub source triggers, GCP only accepts `type=google.cloud.pubsub.topic.v1.messagePublished`. You cannot filter on your own event types at the Eventarc layer. Custom filtering has to happen in the Pub/Sub **subscription** layer (`filter` field) or in the BFF's HTTP handler. The implication: one trigger per subscribing service, not one per event-type.

### 8b. Eventarc Firestore `document` filter REQUIRES `operator = match-path-pattern`

For Firestore source triggers, the `document` matching criterion needs the operator set explicitly:

```hcl
matching_criteria {
  attribute = "document"
  operator  = "match-path-pattern"   # <-- REQUIRED
  value     = "mappings/{code}"
}
```

Without `operator = "match-path-pattern"`, the filter is treated as an **exact-match against the full document path** (with project/db prefix), which never matches in practice. Symptom: trigger exists, looks healthy, **never fires for any doc write**. See `E2E-TEST-ISSUE.md` for the full failure history.

### 9. Identity Platform quota-project trap

`google_identity_platform_config.default` calls the Identity Toolkit API, which is bound to a specific GCP project via the OAuth client_id used by the local ADC. The local `authorized_user` was issued for a different project than `serverless-503308`, so this single resource fails on every apply.

**Resolution:** skip the resource (commented out in `envs/dev/main.tf`). Project-default Identity Platform config gets created automatically when the first user signs in via the Firebase console / client SDK. To re-enable, `gcloud auth login` is needed in the local shell.

### 10. Eventarc service agent IAM is implicit

For an Eventarc trigger with a Pub/Sub source, the **Eventarc service agent** (`service-…@gcp-sa-eventarc.iam.gserviceaccount.com`) needs `roles/eventarc.eventReceiver` on the project. The `google_eventarc_trigger` resource creates most of the IAM but does not grant this. The same role is also needed on the per-BFF Eventarc SA.

**Also missing:** `roles/pubsub.publisher` on the **Google-managed Pub/Sub service agent** (`service-…@gcp-sa-pubsub.iam.gserviceaccount.com`) so it can publish to Eventarc's transport topic.

**Also missing:** `roles/iam.serviceAccountTokenCreator` on each Eventarc SA **for itself** (actAs itself) — required to mint OIDC tokens for pushing to Cloud Run. Without this, the push arrives with `Empty Authorization header` and Cloud Run returns 401.

All four IAM bindings are now in the bff-service module.

## Build / typescript / workspace

### 11. `@google-cloud/pubsub` import path is a `build/` path

```ts
import type { MessageOptions } from '@google-cloud/pubsub/build/src/topic';
```

The public types re-export at `@google-cloud/pubsub` does not include `MessageOptions`. Deep import required.

### 12. Hono does not run on plain Node without `@hono/node-server`

`hono`'s `serve()` uses a Bun/Workers-style API. It's not a plain-Node http server. For Cloud Run, add `@hono/node-server` and `import { serve } from '@hono/node-server'`.

### 13. `tsc -b` build mode + project references need explicit `composite: true`

When using `tsc --build` with multiple packages, every referenced `tsconfig.json` must have `composite: true` AND `rootDir` must resolve to a directory below the tsconfig. The error message is a paragraph of YAML-shaped diagnostics — easy to miss the real cause.

### 14. Cloud Build buildpack ignores `BP_NODE_PROJECT_PATH`

For monorepos with sub-app folders (`apps/<name>/`), the Node buildpack with `BP_NODE_PROJECT_PATH=apps/<name>` is **silently ignored**. The container ends up running `node /workspace/index.js` (workspace root), which doesn't exist. The build "succeeds" (the image is pushed), but Cloud Run fails to start the container with `Cannot find module '/workspace/index.js'`.

**Fix:** use a real multi-stage Dockerfile with `gcr.io/cloud-builders/docker`. See `terraform/scripts/cloudbuild.yaml` and `apps/<name>/Dockerfile` for the working approach.

### 15. `npm run build -w apps/<name>` is the right workspace command

The root `package.json` does not have a `build` script by default. To build a specific app from the workspace root in Cloud Build, use `npm run build -w apps/<name>` (the npm workspaces syntax), not `--workspace=` (which is a yarn-style flag that npm ignores).

## Cloud Run / Cloud Build

### 16. Cloud Run "Initializing project for the current region"

First apply to a new region on a project can take 5-15 minutes while GCP stands up the regional control plane. Cloud Run returns `CONDITION_FAILED: Initializing` for that whole window. If you `Ctrl-C` the apply during that window, you are stuck in #6 above.

### 17. Region pre-warm vs. service creation

Creating a Cloud Run service in a "cold" region: the service sits in `CONDITION_FAILED` for up to 10 minutes. Terraform's `wait_for_ready` does not help because the resource is created but the service is not yet serving. The first `curl https://<svc>...run.app` may also return 502/503 for the same window.

### 18. Service identity drift on every apply

The `lifecycle.ignore_changes` block on `google_cloud_run_v2_service` is mandatory. Without it, every apply tries to "fix" the resource back to first-failed-apply values and times out on region init. The minimum list is `[labels, scaling, deletion_protection, template[0].scaling]`.

## Workflow / process

### 19. Plan → apply separation saved us multiple times

The skill's rule "never combine plan and apply" caught the Eventarc IAM error and the Identity Platform quota-project error before any side effects. **Follow this rule.**

### 20. `terraform plan` can show "no changes" but state is still drifting

After import + ignore_changes, the plan was clean but the live resources (Cloud Run services) were still in `CONDITION_FAILED`. Always cross-check with `gcloud` before declaring a stack "applied."

### 21. The first `terraform apply` for an empty project takes 5-10 minutes

APIs take time to propagate. IAM takes time to propagate. Eventarc takes time to propagate. The first apply, even with no errors, will sit at "still creating" for several minutes per resource.

### 22. Eventarc transport backoff is real

After a few delivery failures (e.g. 401 from missing OIDC), the Eventarc transport subscription stops re-delivering. There is no admin command to "reset" the backoff. The only way out is to delete and recreate the trigger (or wait for the exponential backoff to cap at 600s and try again).

## What I would do differently next time

- Pre-warm the region first before the first real apply.
- Skip Hono's `serve()` entirely on day one — use `@hono/node-server` from the start.
- Bake `lifecycle.ignore_changes` into the bff-service module template by default.
- Build the Eventarc service-agent + token-creator IAM bindings into the bff-service module from the start.
- Skip `identity` module until after the rest is green.
- **Use multi-stage Dockerfiles from day one** for the build. Don't waste time on buildpacks for monorepos.
- For Firestore Eventarc triggers, **always include `operator = "match-path-pattern"`** on the `document` criterion. There's no way to discover this from the GCP docs without writing a test trigger first.
