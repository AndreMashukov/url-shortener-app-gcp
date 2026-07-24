#!/usr/bin/env bash
# deploy-bff.sh — Cloud Build image + pin Cloud Run to that build's digest.
#
# Usage:
#   ./scripts/deploy-bff.sh <app-name>
#   PROJECT_ID=... REGION=... ./scripts/deploy-bff.sh analytics-bff
set -euo pipefail

APP_NAME="${1:?usage: deploy-bff.sh <app-name>}"
case "${APP_NAME}" in
  app-bff|redirect-bff|analytics-bff) ;;
  *)
    echo "unsupported app name: ${APP_NAME}" >&2
    echo "allowed: app-bff | redirect-bff | analytics-bff" >&2
    exit 2
    ;;
esac

PROJECT_ID="${PROJECT_ID:-serverless-503308}"
REGION="${REGION:-asia-southeast1}"
REPO="${ARTIFACT_REGISTRY_REPO:-url-shortener-apps-dev}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${APP_NAME}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if [[ -z "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]] && command -v gcloud >/dev/null 2>&1; then
  if gcloud auth application-default print-access-token >/dev/null 2>&1; then
    export CLOUDSDK_AUTH_ACCESS_TOKEN
    CLOUDSDK_AUTH_ACCESS_TOKEN="$(gcloud auth application-default print-access-token)"
  fi
fi

export CLOUDSDK_CORE_PROJECT="${PROJECT_ID}"

echo "== Cloud Build ${APP_NAME} =="
# Capture this build's results so we pin Cloud Run to *this* digest,
# not whatever :latest happens to point at after a concurrent deploy.
BUILD_JSON="$(gcloud builds submit \
  --config=terraform/scripts/cloudbuild.yaml \
  --substitutions="_APP_NAME=${APP_NAME}" \
  --region="${REGION}" \
  --format=json \
  .)"

DIGEST="$(printf '%s' "${BUILD_JSON}" | python3 -c '
import json, sys
build = json.load(sys.stdin)
images = (build.get("results") or {}).get("images") or []
if not images:
    raise SystemExit("Cloud Build results.images is empty — cannot resolve digest")
digest = images[0].get("digest")
if not digest:
    raise SystemExit("Cloud Build image entry has no digest")
print(digest)
')"
echo "DIGEST=${DIGEST} (from this Cloud Build)"

echo "== Cloud Run update ${APP_NAME} =="
gcloud run services update "${APP_NAME}" \
  --region="${REGION}" \
  --image="${IMAGE}@${DIGEST}" \
  --quiet

gcloud run services describe "${APP_NAME}" \
  --region="${REGION}" \
  --format='value(status.latestReadyRevisionName,status.url)'
echo "OK deployed ${APP_NAME}"
