# AGENTS.md — URL Shortener on GCP

Instructions for AI agents working in this repository.

## Project overview

GCP port of the AWS `url-shortener-app` (see
`/opt/data/serverless/url-shortener-app/`). Same product, same
event-sourced / CQRS shape, ported to Google Cloud.

| Component   | Directory / GCP primitive                                       |
|-------------|-----------------------------------------------------------------|
| Event hub   | Pub/Sub topic `url-shortener-events` + DLQ                      |
| App BFF     | Cloud Run v2 service `app-bff` + Firestore DB `app-db`          |
| Redirect BFF| Cloud Run v2 service `redirect-bff` + Firestore DB `redirect-db`|
| Analytics BFF| Cloud Run v2 service `analytics-bff` + Firestore DB `analytics-db` |

**Region:** `asia-southeast1`. **Default env:** `dev`.

## Companion docs (read first)

- `BRAINSTORM.md` — design decisions, primitive map, event flow,
  risks. **This is the source of truth for architecture.**
- `/opt/data/serverless/url-shortener-app/AGENTS.md` — the AWS
  sibling; useful to compare patterns and not lose context.

## Commands

Nx 23 workspace (StudyForge-style `project.json` per app/lib). Prefer `nx`
targets over ad-hoc scripts.

```bash
npm install
npx nx show projects
npx nx run-many -t build
npx nx run-many -t typecheck

# Deploy BFFs (Cloud Build → Artifact Registry → Cloud Run digest pin)
npx nx run app-bff:deploy
npx nx run redirect-bff:deploy
npx nx run analytics-bff:deploy
# or: npx nx run-many -t deploy -p app-bff,redirect-bff,analytics-bff --parallel=1

npm run test

# Terraform (per-env)
cd terraform/envs/dev
terraform init -input=false
terraform plan -input=false -out=./dev.tfplan
# STOP — ask for approval
terraform apply -input=false ./dev.tfplan
```

**Nx + Hermes note:** `node_modules` is shared via the Docker mount. Nx’s
native binary is platform-specific — run `nx` on the host (darwin) when the
Hermes linux/amd64 container reports `WorkspaceContext is not a constructor`.
Deploy still uses host `gcloud` + ADC (`GOOGLE_APPLICATION_CREDENTIALS`).

## IaC: Terraform (per the gcp-terraform-cloud-run skill)

- Source of truth for ALL cloud resources. No `gcloud run deploy`
  in production.
- Plan → approval → apply gate is mandatory. Never combine plan and
  apply in one tool call.
- State in GCS per env (`gs://<project>-tfstate/<env>/terraform.tfstate`).
- Modules in `terraform/modules/`, instantiated by
  `terraform/envs/<env>/main.tf`.

## Debugging live GCP resources

When the task involves **actual deployed state** (Cloud Run errors,
Firestore docs, Pub/Sub messages, IAM, deploy history, "is it
live?"), use `gcloud` and the skill's scripts:

```bash
bash /shared/infra/gcp/scripts/gcp-auth-check.sh
bash /shared/infra/gcp/scripts/gcp-connectivity-check.sh
bash /shared/infra/gcp/scripts/gcp-run-status.sh dev
```

| Live GCP question      | Tool                                                            |
|------------------------|-----------------------------------------------------------------|
| Cloud Run service health | `gcloud run services describe`, `gcloud run services logs read`|
| Firestore documents    | `gcloud firestore documents list`                              |
| Pub/Sub messages       | `gcloud pubsub subscriptions pull`, `gcloud pubsub topics list` |
| IAM                    | `gcloud projects get-iam-policy`                               |
| Cost / quota          | `gcloud billing ...`, `gcloud services list --enabled`         |

## Code conventions

- **Node 20+**, TypeScript, npm workspaces (the GCP container does
  not have yarn installed; AWS sibling uses yarn, GCP uses npm).
- Match the AWS sibling's patterns where it makes sense; isolate
  cloud SDK calls behind `libs/firestore`, `libs/pubsub`,
  `libs/auth`, `libs/proto-decode`.
- Minimal diffs — only change what the task requires.
- Never commit `.env`, `terraform.tfvars` (use `.example`), or
  service-account JSON.
- Only create git commits when the user explicitly asks.

## Key architecture rules (from BRAINSTORM.md)

- **Firestore-trigger is the sole producer of `mapping.created`.**
  app-bff HTTP handlers MUST NEVER call Pub/Sub directly. The
  Firestore Eventarc trigger publishes exactly once per write.
- **Sole-producer exception: `click.recorded`** is published by
  the redirect-bff HTTP handler (fire-and-forget, do not block
  the redirect).
- **Per-BFF data ownership.** Each BFF owns one Firestore DB.
  Analytics reads ONLY `analytics-db`. `ownerUid` is denormalized
  onto lean_view and clicks docs so no cross-DB reads happen.
- **Idempotency on `eventId`.** All Pub/Sub handlers are
  at-least-once. Use the Firestore document path or the eventId
  as the natural idempotency key.
- **Eventarc Firestore payloads are protobuf DocumentEventData**,
  delivered in CloudEvents binary mode (`ce-*` headers + raw body).
  Decode with `libs/proto-decode`; never `JSON.parse` / `text()` the body.

## Repo layout

```
url-shortener-app-gcp/
├── BRAINSTORM.md          # design source of truth
├── AGENTS.md              # this file
├── README.md              # human quickstart
├── package.json           # npm workspace root
├── nx.json
├── tsconfig.base.json
├── terraform/
│   ├── modules/           # reusable: event-hub, bff-service, identity
│   ├── envs/              # dev/, staging/, prod/ — compose modules
│   └── scripts/           # plan-gate wrappers, smoke helpers
├── apps/
│   ├── event-hub/         # placeholder: bus-only, no app code
│   ├── app-bff/           # POST /shorten, GET /me/urls
│   ├── redirect-bff/      # GET /{code} -> 302
│   └── analytics-bff/     # GET /analytics/{code} (auth, owner-only)
├── libs/
│   ├── events/            # zod schemas for event payloads
│   ├── auth/              # Identity Platform JWT verify middleware
│   ├── firestore/         # client factory + collection helpers
│   ├── pubsub/            # publish + subscribe helpers
│   ├── http/              # shared Hono router + error model
│   └── proto-decode/      # Firestore DocumentEventData decode
└── scripts/
    ├── seed-user.ts       # test user via firebase-admin
    └── e2e-smoke.ts       # end-to-end smoke (port of AWS smoke)
```

## Related skills (Hermes)

- `devops/gcp-terraform-cloud-run` — Terraform + Cloud Run workflow
- `gcp-terraform-cloud-run/references/command-risk-classes.md` —
  what requires approval before running
