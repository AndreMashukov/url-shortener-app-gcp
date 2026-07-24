# URL Shortener on GCP — Brainstorm & Design Plan

> Companion brainstorm to the AWS reference build at
> `/opt/data/serverless/url-shortener-app/`. Same product, same
> event-sourced / CQRS shape, ported to Google Cloud.
> Decisions captured here; nothing in this repo is wired yet.

---

## 0. Goals and non-goals

**Goals**
- Re-implement the AWS URL shortener on GCP without losing its shape:
  one bus, three BFFs (app / redirect / analytics), each owns its data.
- Use Cloud Run v2 as the per-service compute primitive (mirrors
  Lambda per-BFF).
- Provision everything from this container with Terraform; follow the
  `gcp-terraform-cloud-run` skill's plan → approval → apply workflow.
- Keep BFF code (handlers, models, lib) portable across AWS and GCP
  by isolating cloud SDK calls in a thin `infra/` adapter per service.

**Non-goals (for v1)**
- Multi-region active-active. Single region (`asia-southeast1`) per env.
- Production-grade cost dashboards or autoscaling tuning. Bursty traffic
  is fine; Cloud Run scales to zero.
- EventBridge Archive or replay tooling (Pub/Sub doesn't have an exact
  analog; we get retention + DLQ for free).
- A custom domain with managed certificates beyond what the dev/staging
  Terraform module already provides.

---

## 1. AWS → GCP primitive map

Each row is a 1:1 concept substitution. The product shape stays the
same; only the cloud primitives change.

| Concern                    | AWS (current)                                            | GCP (target)                                                |
|----------------------------|----------------------------------------------------------|-------------------------------------------------------------|
| Compute (per BFF)          | Lambda + HTTP API Gateway v2                             | Cloud Run v2 service (HTTPS, per-service URL)               |
| API edge                   | HTTP API Gateway v2 (JWT authorizer)                     | Cloud Run built-in HTTPS + Identity Platform JWKS verify    |
| Auth (user-facing)         | Cognito User Pool + JWT                                  | Identity Platform (Firebase Auth under the hood), same JWT shape |
| Event bus                  | EventBridge custom bus + archive                         | Pub/Sub topic (one "bus" topic, structured payloads)        |
| Change data capture        | DynamoDB Streams (Lambda trigger)                        | Firestore native triggers via Eventarc                      |
| Primary data store (BFFs)  | DynamoDB single-table (mappings, lean view, clicks)      | Firestore (Native mode), one database per BFF               |
| Async fan-out              | SQS + EventBridge Pipe                                   | Pub/Sub subscription with push to Cloud Run                 |
| Short code generation      | Random + retry on collision                              | Same algorithm; collision check on Firestore document path  |
| Service-to-service auth    | IAM SigV4 (Lambda → EventBridge, DDB streams)           | IAM (Cloud Run service accounts) + Pub/Sub OIDC tokens      |
| Short-lived secret storage | Lambda env vars / SSM Parameter Store                    | Secret Manager (mounted as env var on Cloud Run v2)         |
| Container registry         | (Lambda zip, no registry)                                | Artifact Registry (`asia-southeast1-docker.pkg.dev`)         |
| IaC                        | Serverless Framework v4 + CloudFormation                 | Terraform (`hashicorp/google` v6)                            |
| State                      | CloudFormation-managed (implicit)                        | GCS bucket per env (`tf state` + lock via GCS object)       |
| Monorepo / build           | Nx + yarn workspaces                                     | Nx + yarn workspaces (reuse)                                |
| Observability              | CloudWatch Logs (Lambda) + Metrics                       | Cloud Logging + Cloud Monitoring (Cloud Run integrates)     |

### What's the same on purpose
- **One repo, four deployable units** (the `event-hub` plus three BFFs).
- **Event names**: `mapping.created`, `click.recorded`. Payloads use
  the same JSON shape so handlers can be shared if we ever extract
  them into a `libs/events` package.
- **The DDB-streams-as-sole-producer rule becomes the Firestore-triggers-as-sole-producer rule for `mapping.created`.** Handlers in app-bff write Firestore and *never* call Pub/Sub directly. The Firestore trigger (via Eventarc) emits `mapping.created` exactly once per write. **Exception (intentional, mirrors AWS):** redirect-bff publishes `click.recorded` from the HTTP handler — see Q3. Do not invent a second path that also publishes `mapping.created`.
- **The lean-view pattern** survives: redirect-bff keeps a Firestore
  collection that mirrors the mappings collection, keyed on the short
  code, and **denormalizes `ownerUid`** from `mapping.created` so
  analytics never cross-reads `app-db`.
- **Idempotency**: Pub/Sub delivery is at-least-once (same as
  EventBridge → SQS), so handlers must still be idempotent on the
  `eventId` field. We use the Firestore document path as the
  natural idempotency key on writes.

### What's structurally different
- **No separate EventBridge "archive"** — Pub/Sub has a configurable
  message retention (max 31 days) and DLQ per subscription. We treat
  retention as the archive.
- **No SQS dead-letter pipeline** — instead each Pub/Sub subscription
  (bus consumers *and* the Eventarc transport subscription behind
  the Firestore→publisher trigger) has a DLQ topic that captures N
  retries before quarantine.
- **Identity Platform's issuer is per-project, not per-region** —
  every Cloud Run service in the project verifies the same keys.
  The AWS app's "verify against a specific user-pool issuer" maps
  to `iss = https://securetoken.google.com/<PROJECT_ID>` and the
  shared Google JWKS (see §7).
- **Cloud Run service URLs are stable.** Prefer the deterministic
  form `https://<svc>-<PROJECT_NUMBER>.asia-southeast1.run.app`
  (Terraform outputs expose `uri`). Do not hard-code legacy hash
  URLs (`…-<hash>-uc.a.run.app` is us-central1-era notation). No
  custom domain in v1 unless we need it for the redirect experience.
- **Only one Firestore database per project gets free quota.** Three
  named BFF databases means billed usage from day one; budget alert
  is mandatory (see §12).

---

## 2. Repository layout

We keep the AWS repo untouched and build a parallel tree. The two
can share a `libs/` workspace later via a path-based yarn workspace
if we want, but for v1 the GCP repo is fully self-contained.

```
url-shortener-app-gcp/
├── README.md                        # GCP-specific quickstart
├── BRAINSTORM.md                    # this file
├── AGENTS.md                        # agent conventions (mirrors AWS AGENTS.md)
├── package.json                     # workspace root
├── nx.json                          # Nx config
├── tsconfig.base.json
├── terraform/
│   ├── modules/
│   │   ├── event-hub/               # Pub/Sub topic + DLQ topic + IAM
│   │   ├── bff-service/             # one Cloud Run v2 + Firestore + Eventarc trigger
│   │   └── identity/                # Identity Platform config (project-default; no tenant in v1)
│   ├── envs/
│   │   ├── dev/
│   │   │   ├── main.tf              # compose all four modules
│   │   │   ├── variables.tf
│   │   │   ├── outputs.tf
│   │   │   ├── backend.tf           # GCS bucket for tfstate
│   │   │   └── terraform.tfvars
│   │   ├── staging/
│   │   └── prod/
│   └── scripts/                     # tf plan-gate, env init, smoke helpers
├── apps/
│   ├── event-hub/                   # placeholder: bus-only, no code
│   ├── app-bff/                     # authoring BFF (POST /shorten, GET /me/urls)
│   ├── redirect-bff/                # redirect BFF (GET /{code} -> 302)
│   └── analytics-bff/               # analytics BFF (GET /analytics/{code})
├── libs/
│   ├── events/                      # shared event payload types + schemas (zod)
│   ├── auth/                        # Identity Platform JWT verify (middleware)
│   ├── firestore/                   # Firestore client factory + collection helpers
│   ├── pubsub/                      # publish/subscribe client factory (admin SDK)
│   └── http/                        # shared Hono / Express router + error model
├── scripts/
│   ├── seed-user.ts                 # create a test user (uid = owner)
│   └── e2e-smoke.ts                 # end-to-end smoke (port of AWS smoke)
└── .github/workflows/
    └── plan-apply.yml               # stub until first e2e; then plan on PR / apply on main
```

> We will **not** copy the AWS Nx executor targets blindly. The GCP
> Nx targets will be: `build:docker`, `push:image`, `deploy:dev`,
> `info`. We will not generate `serverless.yml`-style artifacts; the
> Terraform module references the image by digest from Artifact
> Registry.

---

## 3. Service decomposition (mirroring the AWS split)

| BFF              | AWS analog                  | Responsibility                                                    | Owns                                                  |
|------------------|-----------------------------|-------------------------------------------------------------------|-------------------------------------------------------|
| `event-hub`      | `url-shortener-event-hub`   | Pub/Sub topics + DLQs + IAM for cross-service publish/subscribe   | Topic `url-shortener-events` + DLQ `…-events-dlq`      |
| `app-bff`        | `url-shortener-app-bff`     | `POST /shorten`, `GET /me/urls` (auth)                             | Firestore DB `app-db` with `mappings` collection      |
| `redirect-bff`   | `url-shortener-redirect-bff`| `GET /{code}` → 302; reads lean view; emits `click.recorded`       | Firestore DB `redirect-db` with `lean_view` (`code`, `longUrl`, `ownerUid`, `createdAt`) |
| `analytics-bff`  | `url-shortener-analytics-bff` | `GET /analytics/{code}` (auth, owner-only); aggregates clicks   | Firestore DB `analytics-db` with `clicks` (`count`, `ownerUid`, `lastClickedAt`) |

**Deploy order** (mirrors the AWS `event-hub → app-bff → redirect-bff + analytics-bff`):
1. `terraform apply -target=module.event_hub` (creates topics + IAM)
2. `terraform apply -target=module.app_bff`
3. `terraform apply -target=module.redirect_bff` and
   `module.analytics_bff` (parallel-safe; both depend on event-hub only)

**What gets a Cloud Run service vs. just a Firestore trigger**
- `app-bff`: one Cloud Run service for the HTTP API + one Eventarc
  trigger that watches `mappings/{code}` creates and publishes
  `mapping.created` to the bus. Filters:
  `type=google.cloud.firestore.document.v1.created`,
  `database=app-db`, path-pattern `document=mappings/{code}`.
  Trigger location must be `asia-southeast1` (same as the DB).
  Event data is **protobuf** (`application/protobuf`
  `DocumentEventData`) — decode in `libs/`, not JSON snapshots.
  IAM: Eventarc SA needs `roles/eventarc.eventReceiver` +
  `roles/run.invoker` on the publisher service; attach a DLQ on
  the Eventarc transport subscription.
- `redirect-bff`: one Cloud Run service for the HTTP API + one
  Eventarc trigger on Pub/Sub (`google.cloud.pubsub.topic.v1.messagePublished`)
  that materializes the lean-view document (including `ownerUid`).
  The service itself also publishes `click.recorded` to the bus on
  each redirect (sole-producer exception; Q3).
- `analytics-bff`: one Cloud Run service for the HTTP API + one
  Eventarc trigger on Pub/Sub that aggregates click counts into
  the `clicks` collection (stores `ownerUid` from the event for
  owner-only reads — never queries `app-db`).

---

## 4. Event flow (ported to Pub/Sub semantics)

### A. Mapping creation

```
client → POST /shorten
  app-bff Cloud Run → verify Identity Platform JWT
                   → generate short code (nanoid, 7 chars)
                   → check Firestore: document path `mappings/{code}` exists?
                       yes → retry with new code (max 5)
                       no  → create document (idempotencyKey from JWT uid + nano suffix)
                   → 201 Created { shortCode, shortUrl, longUrl }

Firestore native trigger (via Eventarc)
  → onCreate of `mappings/{code}` (protobuf DocumentEventData)
  → decode fields; publish to Pub/Sub topic `url-shortener-events`:
      {
        eventId: <CloudEvent id, stable across retries>,
        type: "mapping.created",
        data: { code, longUrl, ownerUid, createdAt }
      }

redirect-bff Eventarc listener (Pub/Sub → Cloud Run)
  → verify eventId not already processed (Firestore doc id)
  → upsert `lean_view/{code}` = { code, longUrl, ownerUid, createdAt }
  → 200 ack

analytics-bff Eventarc listener (Pub/Sub → Cloud Run)
  → ignores `mapping.created` (AWS parity: no analytics seed on create)
```

### B. Click + analytics

```
client → GET /{code} (anonymous)
  redirect-bff Cloud Run
    → read lean_view/{code} (single Firestore get; warm container -> ~5ms)
    → publish `click.recorded` to bus (fire-and-forget; do not block redirect):
        { eventId, type: "click.recorded", data: { code, ownerUid, clickedAt } }
    → 302 Location: <longUrl>

analytics-bff Eventarc listener
  → on first `click.recorded`: create `clicks/{code}` with
      `{ code, ownerUid, count: 1, lastClickAt }`
  → on later clicks: atomic increment + update lastClickAt
  → 200 ack
```

### C. Analytics read

```
client → GET /analytics/{code} (Identity Platform JWT; owner = clicks.ownerUid)
  analytics-bff Cloud Run
    → verify JWT, extract uid
    → read clicks/{code} from analytics-db only
    → 404 if missing (no clicks yet)
    → 403 if ownerUid != uid
    → 200 { code, ownerUid, count, lastClickAt }
```

This is structurally identical to the AWS design, with two GCP-specific
notes: lean-view materialization is at-least-once via Pub/Sub, and
`ownerUid` is denormalized into lean_view + clicks so analytics never
cross-reads `app-db`.

---

## 5. Why this primitive mapping is right (and where it might bite)

### Where it lines up cleanly
- **Event delivery at-least-once** is identical to EventBridge → SQS.
  Our handlers already do idempotency on `eventId`; no code changes.
- **The "stream trigger is the only producer" rule** applies to
  `mapping.created` (Firestore Eventarc → publisher → bus). The
  publisher is a dedicated Cloud Run service; audit that app-bff
  HTTP handlers never publish. `click.recorded` is the documented
  exception (handler emit).
- **Per-BFF data ownership** is unchanged: each BFF has its own
  Firestore database. Ownership checks use denormalized `ownerUid`
  on analytics docs — no cross-DB reads.
- **JWT-based auth shape** is unchanged. Identity Platform issues
  RS256 tokens; `libs/auth` swaps issuer/audience and the Google
  JWKS URL (or uses `firebase-admin` `verifyIdToken`).

### Where we'll have to make tradeoffs

**1. Firestore as a key-value store, not a relational store.**
The AWS app uses a single-table DDB design with composite keys.
Firestore is document-based with single-field indexes; we'll model
each collection as a flat document set (`mappings/{code}` as the
natural key, with `ownerUid` indexed for the `GET /me/urls` query).
This is slightly more work to query, but Firestore indexes
support composite (`ownerUid ASC, createdAt DESC`) so we keep
the same query patterns.

**2. Firestore triggers deliver once per write — but if the Eventarc
destination is down, the write still committed.** Eventarc's
underlying Pub/Sub subscription defaults to ~**24 hours** retention
with exponential backoff — *not* our bus topic's 7-day retention.
Bus retention only helps *after* the publisher successfully
publishes `mapping.created`. Mitigation: DLQ on the Eventarc
transport subscription + alert on DLQ depth; optionally raise
Eventarc subscription retention. AWS has the same class of risk;
we accept it with explicit DLQ, not "Pub/Sub 7d saves us."

**2b. Three named Firestore databases are billed.** Free quota
applies to **exactly one** database per project. Dev is not "free
tier" under the per-BFF bulkhead. Mitigation: project budget alert
(§12); if cost becomes painful in dev, collapse to one DB with
collection-prefix isolation later — not the v1 default.

**3. Cloud Run cold starts vs. Lambda init.**
First request after idle: ~300-800ms. Lambda init is ~150-300ms.
For a redirect service this matters. We will:
- Set `min-instances = 1` in dev/staging to keep the lean-view
  reader warm.
- For prod, start with `min-instances = 1` and add autoscaling
  rules when we have traffic data.

**4. Pub/Sub ordering and the lean-view race.**
Pub/Sub does not guarantee per-key ordering. If two
`mapping.created` events for the same code arrive out of order,
the lean-view upsert is order-insensitive (same payload), so this
is a non-issue. We *do* lose the "second writer wins" property of
DDB conditional writes; for v1 we accept that and add a `version`
field for optimistic locking if/when we add `PUT /shorten/:code`.

**5. Identity Platform quota in dev.**
Identity Platform (Firebase Auth) is "pay-as-you-go" above 50K
monthly active users. We are well under that in dev. Staging
and prod: same model, just watch the bill.

**6. Region drift.**
AWS uses `ap-southeast-1`. GCP equivalent: `asia-southeast1`
(Singapore). Different timezones, different pricing, different
quota names. The skill file is the source of truth for region
selection; we will keep `asia-southeast1` consistent across all
GCP resources.

---

## 6. Terraform layout (detailed)

The skill (`gcp-terraform-cloud-run`) is the operating manual.
This section adapts it to the four-stack shape we need.

### Module: `event-hub`
Resources:
- `google_pubsub_topic.url_shortener_events`
- `google_pubsub_topic.url_shortener_events_dlq`
- `google_pubsub_subscription.dlq_catch_all` (just a sink)
- IAM: a `eventhub-publisher` service account; a
  `eventhub-subscriber` service account per BFF.

Outputs: `topic_name`, `dlq_topic_name`, `publisher_sa_email`.

### Module: `bff-service` (parameterized; instantiated 3x)
Inputs: `service_name`, `image`, `region`, `env_vars`,
`secret_env_vars`, `invoker_policy` (allUsers vs. allAuthenticatedUsers
vs. IAM-only), `firestore_database_id`, `firestore_collection`,
`subscribes_to` (list of Pub/Sub triggers), `publishes_to` (topic
name).

Resources:
- `google_firestore_database.<svc>` (Native mode, location `asia-southeast1`)
- `google_firestore_index` (composite for the queries we need)
- `google_service_account.<svc>-runtime` (Cloud Run identity)
- `google_service_account.<svc>-eventarc` (Eventarc trigger identity;
  `roles/eventarc.eventReceiver`, `roles/run.invoker`, Pub/Sub
  publisher as needed)
- `google_project_iam_member` (roles: Datastore User, Pub/Sub Publisher,
  Pub/Sub Subscriber, Secret Manager Secret Accessor as needed)
- `google_cloud_run_v2_service.<svc>` (image, env, secrets, scaling)
- `google_cloud_run_v2_service_iam_member` (invoker policy)
- `google_eventarc_trigger.firestore_to_bus` (only for app-bff;
  location = `asia-southeast1`, `event_data_content_type` =
  `application/protobuf`, filters for database + document path)
- `google_eventarc_trigger.pubsub_to_svc` (for redirect + analytics
  consumers of the bus)
- `google_pubsub_subscription.<svc>-events` (push to Cloud Run, with
  DLQ → event-hub DLQ)
- DLQ policy on the Eventarc transport subscription for
  `firestore_to_bus` (look up via trigger `transport.pubsub.subscription`)
- `google_secret_manager_secret` + IAM for any per-BFF secrets

Outputs: `service_url` (prefer deterministic
`https://<svc>-<PROJECT_NUMBER>.asia-southeast1.run.app`),
`service_account_email`, `firestore_database`, `subscription_name`.

### Module: `identity`
- `google_identity_platform_config` (sign-in providers, MFA off in
  dev). Prefer **project-default** auth for v1 — skip multi-tenant
  unless we need isolated user pools.
- Optional later: `google_identity_platform_tenant` if multi-tenancy
  is required.
- IAM helper for the test-user creation in `scripts/seed-user.ts`

> **Note**: Terraform supports `google_identity_platform_config` and
> tenants well enough for v1. Enable the Identity Toolkit API once
> (may need a one-time `gcloud services enable identitytoolkit.googleapis.com`
> bootstrap). Prefer project-default config over inventing a tenant.

### Environments
Three env dirs (`dev`, `staging`, `prod`) each `compose` the modules
above. State backend = GCS bucket, one prefix per env:
`gs://<project>-tfstate/<env>/terraform.tfstate`. Lock via GCS
object (Terraform native).

### Plan → approval → apply
Follow the skill verbatim. No mutation without explicit user
approval. For dev we will accept `terraform apply -auto-approve`
*only* after the plan summary is in chat, per the skill's gate.

---

## 7. Auth: porting Cognito → Identity Platform

### Token shape
Both Cognito and Identity Platform issue RS256 JWTs with `sub`,
`email`, `exp`, and a custom-claims bag. Our `libs/auth` already
verifies these via `jose` and the AWS JWKS; we swap to:
- `JWKS_URI = https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`
  (also advertised as `jwks_uri` from
  `https://securetoken.google.com/<PROJECT_ID>/.well-known/openid-configuration`
  — do **not** use `…/jwks.json` under securetoken.google.com)
- `ISSUER = https://securetoken.google.com/<PROJECT_ID>`
- `AUDIENCE = <PROJECT_ID>`

Alternatively, call `firebase-admin` `verifyIdToken` and skip
manual JWKS fetch — preferred for the smoke/admin path.

Cloud Run itself does **not** verify the JWT in the request layer
(that's a Cognito-User-Pools-Authorizer-thing). Instead, the
app-bff and analytics-bff run a verify step in their request
middleware. Redirect-bff is anonymous (`allUsers:run.invoker`).
This is the same model AWS HTTP API v2 + Cognito uses; the
"authorizer" is just an in-process middleware in our case.

### Custom claims for "owner-only"
AWS uses Cognito's `custom:role` or group claims. Identity
Platform uses custom claims set via the Admin SDK. For analytics
authorization we compare JWT `uid` / `sub` to the denormalized
`ownerUid` on `clicks/{code}` (not a custom claim bag, and not a
cross-DB mappings read). Optional custom claims remain available
for roles later.

### Test user creation
The AWS `scripts/e2e-smoke.py` creates a Cognito user, mints a
JWT, and runs the flow. The GCP `scripts/e2e-smoke.ts` will:
- Use `firebase-admin` to create a test user
- Mint an ID token (uid is the owner identifier)
- Run the same flow (`POST /shorten` → redirect → analytics)

---

## 8. Open questions for the user

These will change the doc and the plan if answered differently.
Marked `[Q1]` … `[Q6]` so we can refer to them by number.

**[Q1] Firestore mode**: Native (we picked this) vs. Datastore
mode. Native gives us collection-group queries; Datastore mode
keeps the entity-group model. **Resolved: Native.**

**[Q2] Identity Platform vs. self-rolled JWTs**: We picked
Identity Platform. **Resolved: Identity Platform.**

**[Q3] Should the redirect BFF be the one that publishes
`click.recorded`, or should an Eventarc Firestore trigger on
`lean_view/{code}.lastAccessedAt` do it?** The AWS design has
the redirect handler do the publish (the `trigger.ts` pattern).
We can keep that, or move to a trigger. **Resolved (default):
handler emit** — intentional sole-producer exception for clicks.
Firestore triggers on every read if you key off `lastAccessedAt`,
and we already have the request in hand. Speak up only if you
want trigger-based clicks instead.

**[Q4] What is the redirect BFF's behavior for a `POST /shorten`
write that has not yet materialized in the lean view?** AWS
app returns 201 immediately (write committed) and lets the
stream catch up. Same here: lean view is eventually consistent,
and a `GET /{code}` immediately after `POST /shorten` may 404
for ~1–3 seconds. **Resolved (default): acceptable for v1**, with
an optional mappings read-fallback behind a feature flag for
smoke/e2e (circuit-breaker; do not make it the hot path).

**[Q5] Region**: `asia-southeast1` is the analog of AWS
`ap-southeast-1`. **Resolved (default): yes.**

**[Q6] Workspace coupling**: do we want the AWS and GCP repos
to share a `libs/` workspace (via yarn workspaces + git
subtree), or stay fully independent for v1? **Resolved
(default): fully independent.** Revisit when we have a third
cloud or a real shared library surface (e.g. publish zod event
schemas as a package later).

---

## 9. Build order (proposed)

1. **Scaffold**: package.json, tsconfig, nx.json, AGENTS.md, README.
   `git init`, push to a new GitHub repo.
2. **`libs/` first**: events, auth (Google JWKS / firebase-admin),
   firestore, pubsub, http, plus a small **protobuf decode helper**
   for Firestore Eventarc payloads. These are shared; the BFFs
   depend on them.
3. **Terraform `event-hub` module** + `envs/dev/main.tf`. Plan,
   approve, apply. Verify topic + DLQ in console.
4. **Terraform `bff-service` module** (without Eventarc triggers
   yet). Plan, approve, apply. Three instantiations create
   app-bff, redirect-bff, analytics-bff.
5. **`app-bff` end-to-end**: Docker build, push to Artifact
   Registry, `terraform apply -var image=…`, verify
   `POST /shorten` writes a Firestore document.
6. **Wire the Firestore trigger**: add the Eventarc trigger
   resource, apply, verify `mapping.created` lands in the topic.
7. **`redirect-bff` listener**: Eventarc Pub/Sub → Cloud Run
   trigger. Verify lean-view materialization in Firestore.
8. **`redirect-bff` happy path**: `GET /{code}` returns 302;
   `click.recorded` lands in the topic.
9. **`analytics-bff` listener + read API**: aggregate clicks;
   `GET /analytics/{code}` returns the count.
10. **Identity Platform + e2e smoke**: test user, JWT, full
    `POST /shorten` → `GET /{code}` → `GET /analytics/{code}`.
11. **Hardening**: Cloud Monitoring alerts, log-based metrics,
    budget alerts, Eventarc transport DLQ alert, runbook.
12. **CI (after first successful e2e)**: enable
    `.github/workflows/plan-apply.yml` — plan on PR, apply on main.

---

## 10. Verification plan (port of the AWS smoke test)

The AWS `scripts/e2e-smoke.py` exercises the full path. The GCP
`scripts/e2e-smoke.ts` will do the same, but with:

- `firebase-admin` to mint the JWT (instead of `boto3.client("cognito-idp")`)
- `@google-cloud/firestore` to verify documents
- `@google-cloud/pubsub` to verify event delivery (optional
  diagnostic; the Eventarc path is the production one)
- HTTP calls to the three Cloud Run service URLs (instead of
  API Gateway URLs)

We will run the smoke from inside the container so we hit
`*.run.app` URLs with a service account that can call the
services. The skill's `gcp-connectivity-check.sh` becomes the
preflight.

---

## 11. What we are NOT doing in v1

- No custom domain mapping. Redirect URLs use the deterministic
  Cloud Run URL
  `https://redirect-bff-<PROJECT_NUMBER>.asia-southeast1.run.app/{code}`
  (from Terraform outputs). We can map a custom domain later.
- No multi-region. Single region per env.
- No CI/CD **until** one successful end-to-end smoke. Workflow file
  may exist in the tree as a stub; it is not enabled until step 12
  of §9. Then: plan on PR, apply on main.
- No cost dashboards or quota alerts beyond a basic project budget
  alert (required — three Firestore DBs are billed).
- No canary deploys. Cloud Run v2 supports traffic splits, but
  we are not using them in v1.

---

## 12. Risks and mitigations

| Risk                                                | Likelihood | Impact | Mitigation                                                                |
|-----------------------------------------------------|------------|--------|---------------------------------------------------------------------------|
| Firestore trigger lag exceeds lean-view SLA         | Low        | Med    | Optional mappings read-fallback behind flag (Q4); do not use as hot path  |
| Eventarc destination down before bus publish        | Med        | High   | DLQ on Eventarc transport sub; alert on DLQ depth; retention ≥ 24h default |
| Bus Pub/Sub retention < audit window                | Low        | High   | Topic/subscription retention = 7 days; `retain_acked_messages` if seek needed |
| Cold-start latency on redirect                      | Med        | Med    | `min-instances = 1` in dev/staging/prod                                   |
| Identity Toolkit API / config not bootstrapped      | Med        | Low    | One-time `gcloud services enable` + TF `google_identity_platform_config`  |
| Cloud Run URL hard-coded / region-suffix drift      | Med        | Med    | Outputs expose deterministic `SERVICE-PROJECT_NUMBER.REGION.run.app` only |
| Network egress via ProtonVPN blocks GCP APIs        | Med        | High   | Run `gcp-connectivity-check.sh` before every apply                        |
| Firestore cost surprise (3 named DBs, no free tier) | Med        | Med    | Budget alert at project level; watch write volume in smoke tests          |
| Handler port (AWS → GCP) drift on `eventId` shape   | Med        | Med    | Centralize event shape in `libs/events`; both clouds use same zod schema  |
| Protobuf decode bugs on Firestore Eventarc payloads | Med        | Med    | Shared decode helper + unit fixtures from DocumentEventData               |
| Custom claim / seed user misconfigured              | Med        | Med    | `scripts/seed-user.ts` is the single source of truth for test-user setup  |
| Analytics cross-DB ownership check creeps back in   | Low        | Med    | Enforce: analytics reads only `analytics-db`; `ownerUid` on clicks docs   |

---

## 13. Next steps

Defaults for Q3–Q6 are locked in §8 (handler emit; eventual lean-view
OK with optional fallback; `asia-southeast1`; independent repos).
Once you sign off on the build order in §9 (or adjust),

I will:
1. Initialize the new repo at `/opt/data/serverless/url-shortener-app-gcp/`
   and commit the scaffold.
2. Mirror it to a new GitHub repo (`url-shortener-app-gcp.git`)
   using the same convention as the AWS app's mirrors.
3. Start with the `libs/` workspace + the `event-hub` Terraform
   module per §9.
4. Pause after the first successful `terraform apply` so you can
   see real output before we keep building.
