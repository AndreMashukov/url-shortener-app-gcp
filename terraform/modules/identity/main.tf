# terraform/modules/identity
#
# Identity Platform / Firebase Auth configuration.
# Per BRAINSTORM §6, we use PROJECT-DEFAULT auth for v1 — no tenant
# in v1. The resource below is enough to enable the Identity
# Platform service at the project level so `firebase-admin` can mint
# tokens and our auth middleware can verify them.
#
# A real `google_identity_platform_tenant` will be added in a later
# iteration if/when we need isolated user pools (e.g. for B2B
# multi-tenancy).

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" {
  type = string
}

# Enable Identity Platform / Firebase Auth at the project level. This
# is idempotent; the Terraform provider skips the resource if it is
# already enabled.
resource "google_project_service" "identitytoolkit" {
  project = var.project_id
  service = "identitytoolkit.googleapis.com"

  disable_on_destroy = false
}

# Project-default Identity Platform config. Allows email/password and
# anonymous sign-in. Disable MFA in dev/staging.
# This is a no-op if the config already exists.
resource "google_identity_platform_config" "default" {
  project = var.project_id

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled = true
    }

    anonymous {
      enabled = true
    }

    phone_number {
      enabled = false
    }
  }

  depends_on = [google_project_service.identitytoolkit]
}

output "project_id" {
  value = var.project_id
}
