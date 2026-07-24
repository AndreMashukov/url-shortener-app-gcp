# terraform/modules/event-hub
#
# Pub/Sub topic + DLQ + IAM for cross-service publish/subscribe.
# This is the bus the three BFFs and the Eventarc Firestore trigger
# all publish to / consume from. Per BRAINSTORM §3, §6.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP project id where the bus lives"
}

variable "region" {
  type        = string
  description = "Region for retention labels and topic location (asia-southeast1)"
  default     = "asia-southeast1"
}

variable "topic_name" {
  type        = string
  description = "Name of the bus topic (without project prefix)"
  default     = "url-shortener-events"
}

variable "dlq_topic_name" {
  type        = string
  description = "Name of the dead-letter topic (without project prefix)"
  default     = "url-shortener-events-dlq"
}

variable "message_retention_days" {
  type        = number
  description = "How long Pub/Sub retains unacked messages (max 31)"
  default     = 7
}

locals {
  topic_full_name = "projects/${var.project_id}/topics/${var.topic_name}"
  dlq_full_name   = "projects/${var.project_id}/topics/${var.dlq_topic_name}"
}

# ---------- bus topic ----------
resource "google_pubsub_topic" "events" {
  project = var.project_id
  name    = var.topic_name

  message_retention_duration = "${var.message_retention_days * 24 * 3600}s"

  labels = {
    app  = "url-shortener"
    role = "event-hub"
  }
}

# ---------- DLQ topic ----------
resource "google_pubsub_topic" "events_dlq" {
  project = var.project_id
  name    = var.dlq_topic_name

  message_retention_duration = "${var.message_retention_days * 24 * 3600}s"

  labels = {
    app  = "url-shortener"
    role = "event-hub-dlq"
  }
}

# ---------- publisher service account ----------
# App-bff Firestore-trigger Cloud Run service uses this to publish
# `mapping.created`. Redirect-bff uses it to publish `click.recorded`.
resource "google_service_account" "publisher" {
  project      = var.project_id
  account_id   = "usgcp-eventhub-publisher"
  display_name = "URL shortener event-hub publisher"
  description  = "Publishes mapping.created and click.recorded to the bus topic"
}

resource "google_pubsub_topic_iam_member" "publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.publisher"
  member  = google_service_account.publisher.member
}

# ---------- subscriber service account ----------
# BFF listeners (redirect-bff, analytics-bff) and the Eventarc transport
# subscriptions use this to receive messages.
resource "google_service_account" "subscriber" {
  project      = var.project_id
  account_id   = "usgcp-eventhub-subscriber"
  display_name = "URL shortener event-hub subscriber"
  description  = "Pulls messages from bus subscriptions"
}

# Allow the subscriber SA to consume from the bus (and the DLQ
# catch-all subscription we create below).
resource "google_pubsub_topic_iam_member" "subscriber" {
  project = var.project_id
  topic   = google_pubsub_topic.events.name
  role    = "roles/pubsub.subscriber"
  member  = google_service_account.subscriber.member
}

# ---------- DLQ catch-all subscription ----------
# Anything that nacks into the DLQ ends up here. No consumers; the
# topic is the audit trail. Operators drain manually with `gcloud
# pubsub subscriptions pull`.
resource "google_pubsub_subscription" "dlq_catch_all" {
  project = var.project_id
  name    = "${var.dlq_topic_name}-catchall"
  topic   = google_pubsub_topic.events_dlq.name

  message_retention_duration = "${var.message_retention_days * 24 * 3600}s"
  retain_acked_messages      = true
  ack_deadline_seconds       = 60

  labels = {
    app  = "url-shortener"
    role = "event-hub-dlq-catchall"
  }
}

# ---------- outputs ----------
output "topic_id" {
  description = "Full Pub/Sub topic id (projects/.../topics/...)"
  value       = google_pubsub_topic.events.id
}

output "topic_name" {
  description = "Short topic name (passed to publishMessage)"
  value       = google_pubsub_topic.events.name
}

output "dlq_topic_id" {
  description = "Full DLQ topic id"
  value       = google_pubsub_topic.events_dlq.id
}

output "dlq_topic_name" {
  description = "Short DLQ topic name"
  value       = google_pubsub_topic.events_dlq.name
}

output "publisher_service_account_email" {
  description = "Email of the publisher service account (give roles/iam.serviceAccountUser to anyone who deploys)"
  value       = google_service_account.publisher.email
}

output "subscriber_service_account_email" {
  description = "Email of the subscriber service account"
  value       = google_service_account.subscriber.email
}
