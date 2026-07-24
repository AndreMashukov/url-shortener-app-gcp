#!/usr/bin/env bash
# smoke-bff.sh — exercise the authenticated product path via the
# X-Smoke-Test bypass (libs/auth). Does NOT mint Identity Platform JWTs.
#
# Prereqs:
#   - app-bff deployed with SMOKE_TEST_KEY set (and image that includes the bypass)
#   - ADC available at GOOGLE_APPLICATION_CREDENTIALS (authorized_user with openid scope)
#   - Caller has roles/run.invoker on app-bff / analytics-bff
#
# Usage:
#   SMOKE_TEST_KEY=dev-smoke-key-change-me ./scripts/smoke-bff.sh
#   # or rely on the default below (must match the Cloud Run env var)

set -euo pipefail

SMOKE_TEST_KEY="${SMOKE_TEST_KEY:-dev-smoke-key-change-me}"
PROJECT_ID="${PROJECT_ID:-serverless-503308}"
REGION="${REGION:-asia-southeast1}"

APP_BFF_URL="${APP_BFF_URL:-https://app-bff-hnvjxkvfoq-as.a.run.app}"
REDIRECT_BFF_URL="${REDIRECT_BFF_URL:-https://redirect-bff-hnvjxkvfoq-as.a.run.app}"
ANALYTICS_BFF_URL="${ANALYTICS_BFF_URL:-https://analytics-bff-hnvjxkvfoq-as.a.run.app}"

LONG_URL="${LONG_URL:-https://example.com/smoke-$(date +%s)}"

# Cloud Run IAM rejects opaque OAuth2 access tokens ("access token could
# not be verified"). Mint a Google user ID token from the ADC refresh
# token instead. Hono still ignores this JWT when X-Smoke-Test matches
# and uses uid=smoke-test-user.
ADC_FILE="${GOOGLE_APPLICATION_CREDENTIALS:-/shared/gcp/application_default_credentials.json}"
ID_TOKEN="$(python3 - <<PY
import json, urllib.parse, urllib.request
adc = json.load(open("${ADC_FILE}"))
data = urllib.parse.urlencode({
    "client_id": adc["client_id"],
    "client_secret": adc["client_secret"],
    "refresh_token": adc["refresh_token"],
    "grant_type": "refresh_token",
}).encode()
req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data, method="POST")
resp = json.load(urllib.request.urlopen(req))
print(resp["id_token"])
PY
)"

echo "== smoke-bff =="
echo "APP_BFF_URL=${APP_BFF_URL}"
echo "REDIRECT_BFF_URL=${REDIRECT_BFF_URL}"
echo "ANALYTICS_BFF_URL=${ANALYTICS_BFF_URL}"
echo "LONG_URL=${LONG_URL}"
echo

echo "== 1) POST ${APP_BFF_URL}/shorten =="
SHORTEN_RESP="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' \
  -X POST "${APP_BFF_URL}/shorten" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "X-Smoke-Test: ${SMOKE_TEST_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"longUrl\":\"${LONG_URL}\"}")"
echo "${SHORTEN_RESP}"
SHORTEN_BODY="$(echo "${SHORTEN_RESP}" | sed '/^HTTP_STATUS:/d')"
SHORTEN_STATUS="$(echo "${SHORTEN_RESP}" | sed -n 's/^HTTP_STATUS://p')"
CODE="$(echo "${SHORTEN_BODY}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("code",""))' 2>/dev/null || true)"

if [[ -z "${CODE}" ]]; then
  echo "ERROR: no code in shorten response (status=${SHORTEN_STATUS})" >&2
  exit 1
fi
echo "code=${CODE}"
echo

echo "== 2) wait 15s for Eventarc → bus → lean_view (cold-start) =="
sleep 15
echo

echo "== 3) GET analytics BEFORE click — expect 404 (seed-on-first-click) =="
ANALYTICS_BEFORE="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' \
  -X GET "${ANALYTICS_BFF_URL}/analytics/${CODE}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "X-Smoke-Test: ${SMOKE_TEST_KEY}")"
echo "${ANALYTICS_BEFORE}"
echo

echo "== 4) GET ${REDIRECT_BFF_URL}/${CODE} (no auth; do not follow redirects) =="
REDIRECT_HEADERS="$(mktemp)"
REDIRECT_BODY="$(mktemp)"
REDIRECT_STATUS="$(curl -sS -o "${REDIRECT_BODY}" -D "${REDIRECT_HEADERS}" -w '%{http_code}' \
  "${REDIRECT_BFF_URL}/${CODE}" || true)"
echo "HTTP_STATUS:${REDIRECT_STATUS}"
echo "--- response headers (Location etc) ---"
cat "${REDIRECT_HEADERS}"
echo "--- body ---"
cat "${REDIRECT_BODY}"
echo
echo
rm -f "${REDIRECT_HEADERS}" "${REDIRECT_BODY}"

echo "== 5) wait 15s for click.recorded → analytics seed =="
sleep 15
echo

echo "== 6) GET ${ANALYTICS_BFF_URL}/analytics/${CODE} — expect 200 count>=1 =="
ANALYTICS_RESP="$(curl -sS -w '\nHTTP_STATUS:%{http_code}\n' \
  -X GET "${ANALYTICS_BFF_URL}/analytics/${CODE}" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "X-Smoke-Test: ${SMOKE_TEST_KEY}")"
echo "${ANALYTICS_RESP}"
echo

echo "== done =="
echo "shorten_status=${SHORTEN_STATUS} code=${CODE} redirect_status=${REDIRECT_STATUS}"
