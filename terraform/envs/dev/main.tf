# terraform/envs/dev/main.tf
#
# Compose event-hub, identity, and three bff-service modules.
# This is the entry point: `terraform plan/apply` from this dir.

# Look up the project number once. BFF modules need it to construct
# the Google-managed Eventarc and Pub/Sub service agent emails.
data "google_project" "this" {
  project_id = var.project_id
}

# ----------------------------- event-hub -----------------------------
module "event_hub" {
  source         = "../../modules/event-hub"
  project_id     = var.project_id
  region         = var.region
  topic_name     = "url-shortener-events"
  dlq_topic_name = "url-shortener-events-dlq"
}

# ----------------------------- identity -----------------------------
# The identity module has two resources:
#   1. `google_project_service.identitytoolkit` — API enable (works fine)
#   2. `google_identity_platform_config.default` — fails from local ADC
#      because the OAuth client is bound to a different GCP project
#      (client_id 764086051850-...).
#
# We split: keep the project_service via the module, and bring up the
# config resource out-of-band via `gcloud` after first human auth.
# For now, just enable the API here. The Identity Platform config
# can be a manual one-time step (or via console) — it is not on the
# critical path for v1 because the BFFs will work against the
# project-default config that Identity Platform creates on first use.
#
# To re-enable the full module once the auth situation is fixed,
# uncomment the block below.
#
# module "identity" {
#   source     = "../../modules/identity"
#   project_id = var.project_id
# }

# Enable the identitytoolkit API directly (the only thing the
# identity module does that the BFFs actually need right now).
resource "google_project_service" "identitytoolkit" {
  project = var.project_id
  service = "identitytoolkit.googleapis.com"

  disable_on_destroy = false
}

# ----------------------------- app-bff -----------------------------
# Owns /mappings in app-db Firestore. Has the Firestore→bus Eventarc
# trigger (sole producer of mapping.created). Does NOT subscribe to
# the bus.
module "app_bff" {
  source     = "../../modules/bff-service"
  project_id = var.project_id
  region     = var.region

  project_number = data.google_project.this.number

  service_name          = "app-bff"
  image                 = var.app_bff_image
  allow_unauthenticated = false
  invoker_members       = ["user:andre.mashukov@gmail.com"]

  firestore_database_id          = "app-db"
  firestore_location             = var.region
  firestore_trigger_path_pattern = "mappings/{code}"
  enable_firestore_trigger       = true

  events_topic_id              = module.event_hub.topic_id
  events_topic_name            = module.event_hub.topic_name
  dlq_topic_id                 = module.event_hub.dlq_topic_id
  eventhub_publisher_sa_email  = module.event_hub.publisher_service_account_email
  eventhub_subscriber_sa_email = module.event_hub.subscriber_service_account_email
  subscribes_to_event_types    = [] # app-bff does not consume from the bus

  env_vars = merge(var.common_env_vars, {
    SERVICE_NAME   = "app-bff"
    EVENTHUB_TOPIC = module.event_hub.topic_name
    GCP_PROJECT_ID = var.project_id
    GCP_REGION     = var.region
    SMOKE_TEST_KEY = var.smoke_test_key
  })

  deletion_protection = false
}

# ----------------------------- redirect-bff -----------------------------
# Owns /lean_view in redirect-db. Subscribes to mapping.created.
# Publishes click.recorded (sole-producer exception).
# Anonymous (no auth — public redirects).
module "redirect_bff" {
  source     = "../../modules/bff-service"
  project_id = var.project_id
  region     = var.region

  project_number = data.google_project.this.number

  service_name          = "redirect-bff"
  image                 = var.redirect_bff_image
  allow_unauthenticated = true # public 302 endpoint

  firestore_database_id    = "redirect-db"
  firestore_location       = var.region
  enable_firestore_trigger = false

  events_topic_id              = module.event_hub.topic_id
  events_topic_name            = module.event_hub.topic_name
  dlq_topic_id                 = module.event_hub.dlq_topic_id
  eventhub_publisher_sa_email  = module.event_hub.publisher_service_account_email
  eventhub_subscriber_sa_email = module.event_hub.subscriber_service_account_email
  subscribes_to_event_types    = ["mapping.created"]

  env_vars = merge(var.common_env_vars, {
    SERVICE_NAME   = "redirect-bff"
    EVENTHUB_TOPIC = module.event_hub.topic_name
    GCP_PROJECT_ID = var.project_id
    GCP_REGION     = var.region
    SMOKE_TEST_KEY = var.smoke_test_key
  })

  deletion_protection = false
}
# Owns /clicks in analytics-db. Subscribes to click.recorded only
# (seed-on-first-click; ignores mapping.created). Reads ONLY
# analytics-db (ownerUid denormalized onto the clicks doc).
# Authenticated, owner-only on GET /analytics/{code}; 404 until first click.
module "analytics_bff" {
  source     = "../../modules/bff-service"
  project_id = var.project_id
  region     = var.region

  project_number = data.google_project.this.number

  service_name          = "analytics-bff"
  image                 = var.analytics_bff_image
  allow_unauthenticated = false
  invoker_members       = ["user:andre.mashukov@gmail.com"]

  firestore_database_id    = "analytics-db"
  firestore_location       = var.region
  enable_firestore_trigger = false

  events_topic_id              = module.event_hub.topic_id
  events_topic_name            = module.event_hub.topic_name
  dlq_topic_id                 = module.event_hub.dlq_topic_id
  eventhub_publisher_sa_email  = module.event_hub.publisher_service_account_email
  eventhub_subscriber_sa_email = module.event_hub.subscriber_service_account_email
  subscribes_to_event_types    = ["click.recorded"]

  env_vars = merge(var.common_env_vars, {
    SERVICE_NAME   = "analytics-bff"
    EVENTHUB_TOPIC = module.event_hub.topic_name
    GCP_PROJECT_ID = var.project_id
    GCP_REGION     = var.region
    SMOKE_TEST_KEY = var.smoke_test_key
  })

  deletion_protection = false
}
