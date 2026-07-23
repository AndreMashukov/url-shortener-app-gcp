# url-shortener-app-gcp

GCP port of the AWS serverless URL shortener
(`/opt/data/serverless/url-shortener-app/`). Same product, same
event-sourced / CQRS shape, ported to Google Cloud.

**Read [`BRAINSTORM.md`](./BRAINSTORM.md) first** — it is the design
source of truth (primitive map, event flow, risks, decisions).

## Architecture (one-screen view)

```
                ┌────────────────────────────────────────┐
                │ Pub/Sub topic: url-shortener-events    │
                │ + DLQ: url-shortener-events-dlq        │
                └────────────────────────────────────────┘
                       ▲                ▲        ▲
   mapping.created     │                │        │  click.recorded
   (Firestore trigger) │                │        │  (redirect handler)
                       │                │        │
                ┌──────┴───────┐  ┌─────┴──────┐ │
                │   app-bff    │  │ redirect-bff│ │
                │  Cloud Run   │  │  Cloud Run  │ │
                │  Firestore:  │  │  Firestore: │ │
                │   app-db     │  │ redirect-db │ │
                │  /mappings   │  │ /lean_view  │◄┘
                └──────────────┘  └─────────────┘
                       │                │
                       └────┬───────────┘
                            │
                    ┌───────┴─────────┐
                    │  analytics-bff  │
                    │   Cloud Run     │
                    │   Firestore:    │
                    │   analytics-db  │
                    │   /clicks       │
                    └─────────────────┘
```

## Quickstart

Prereqs: Node 20+, Terraform 1.5+, a GCP project with billing enabled
and the 14 required APIs turned on (see BRAINSTORM §1).

```bash
npm install
npm run typecheck
```

Deploy (per the `gcp-terraform-cloud-run` skill, plan → approval → apply):

```bash
cd terraform/envs/dev
terraform init -input=false
terraform plan -input=false -out=./dev.tfplan   # review
# STOP — paste plan output to the human, wait for "go"
terraform apply -input=false ./dev.tfplan
```

## Service URLs (after apply)

Terraform outputs expose:
- `app_bff_url`        — POST /shorten, GET /me/urls (auth)
- `redirect_bff_url`   — GET /{code} → 302 (anonymous)
- `analytics_bff_url`  — GET /analytics/{code} (auth, owner-only)
- `events_topic`       — the bus topic
- `events_dlq_topic`   — the DLQ topic

## Layout

| Path | What lives there |
|------|------------------|
| `BRAINSTORM.md` | Design source of truth (decisions, flow, risks) |
| `AGENTS.md`     | AI agent conventions |
| `terraform/modules/` | Reusable: `event-hub`, `bff-service`, `identity` |
| `terraform/envs/` | `dev` / `staging` / `prod` — compose modules |
| `apps/`         | One folder per BFF (TypeScript) |
| `libs/`         | Shared library code (events, auth, firestore, pubsub, http, proto-decode) |
| `scripts/`      | `seed-user.ts`, `e2e-smoke.ts` |

## License

UNLICENSED — private monorepo.
