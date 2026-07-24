# terraform/envs/dev/backend.tf
#
# Terraform settings + GCS backend.
# The bucket `serverless-503308-tfstate` must be created manually once
# (it is bootstrap, not module-managed). GCS automatically provides
# object-level locking.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    bucket = "serverless-503308-tfstate"
    prefix = "dev/terraform.tfstate"
  }
}
