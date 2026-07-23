// apps/event-hub — placeholder.
//
// The "event-hub" stack is the bus + IAM only; it is implemented in
// Terraform (terraform/modules/event-hub). This app is reserved for a
// future Eventarc-Firestore-trigger publisher Cloud Run service that
// reads DocumentEventData and publishes `mapping.created` to the bus.
//
// For v1 we wire the publisher inline into the Firestore-trigger
// Cloud Run service (see terraform/modules/bff-service). When that
// service grows enough to deserve its own repo folder, we move the
// handler here.
export {};
