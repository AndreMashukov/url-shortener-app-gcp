variable "project_id" {
  type        = string
  description = "GCP project id for the dev environment"
  default     = "serverless-503308"
}

variable "region" {
  type        = string
  description = "GCP region for all dev resources"
  default     = "asia-southeast1"
}

variable "env" {
  type        = string
  description = "Environment name (used in labels and resource naming)"
  default     = "dev"
}

variable "artifact_registry_repo" {
  type        = string
  description = "Artifact Registry repository id for the BFF container images"
  default     = "url-shortener-apps-dev"
}

variable "app_bff_image" {
  type        = string
  description = "Container image for app-bff (e.g. asia-southeast1-docker.pkg.dev/PROJECT/REPO/app-bff:TAG)"
  default     = "asia-southeast1-docker.pkg.dev/serverless-503308/url-shortener-apps-dev/app-bff:latest"
}

variable "redirect_bff_image" {
  type        = string
  description = "Container image for redirect-bff"
  default     = "asia-southeast1-docker.pkg.dev/serverless-503308/url-shortener-apps-dev/redirect-bff:latest"
}

variable "analytics_bff_image" {
  type        = string
  description = "Container image for analytics-bff"
  default     = "asia-southeast1-docker.pkg.dev/serverless-503308/url-shortener-apps-dev/analytics-bff:latest"
}

# Common env vars passed to every BFF.
variable "common_env_vars" {
  type = map(string)
  default = {
    ENV    = "dev"
    REGION = "asia-southeast1"
  }
}

# Smoke-test bypass key. When non-empty, the libs/auth `X-Smoke-Test`
# header (matching this value) is accepted as a Bearer-equivalent and
# the caller is treated as uid=smoke-test-user. ONLY for dev/smoke.
#
# Provide via terraform.tfvars (gitignored) or TF_VAR_smoke_test_key.
# Stored in Secret Manager and injected as SMOKE_TEST_KEY secret env.
# Leave empty / omit secret wiring in staging/prod so the bypass never engages.
variable "smoke_test_key" {
  type        = string
  sensitive   = true
  description = "Dev-only X-Smoke-Test bypass value. Set in terraform.tfvars — no default."
}
