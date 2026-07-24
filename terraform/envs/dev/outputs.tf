output "events_topic_name" {
  value = module.event_hub.topic_name
}

output "events_topic_id" {
  value = module.event_hub.topic_id
}

output "events_dlq_topic_name" {
  value = module.event_hub.dlq_topic_name
}

output "events_dlq_topic_id" {
  value = module.event_hub.dlq_topic_id
}

output "app_bff_url" {
  value = module.app_bff.service_url
}

output "redirect_bff_url" {
  value = module.redirect_bff.service_url
}

output "analytics_bff_url" {
  value = module.analytics_bff.service_url
}

output "publisher_service_account" {
  value = module.event_hub.publisher_service_account_email
}

output "subscriber_service_account" {
  value = module.event_hub.subscriber_service_account_email
}
