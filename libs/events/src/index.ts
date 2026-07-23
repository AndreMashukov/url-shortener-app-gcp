// libs/events — zod schemas for cross-service event payloads.
// Shared by all three BFFs and the Firestore-trigger publisher so the
// JSON shape of `mapping.created` and `click.recorded` is the single
// source of truth (per BRAINSTORM §1).
import { z } from 'zod';

// mapping.created — emitted by the app-bff Firestore trigger.
// Eventarc gives us a CloudEvent envelope; we put our payload in
// `data` and use the CloudEvent `id` as eventId for idempotency.
export const MappingCreatedData = z.object({
  code:      z.string().min(1).max(64),
  longUrl:   z.string().url(),
  ownerUid:  z.string().min(1),
  createdAt: z.string().datetime(),
});
export type MappingCreatedData = z.infer<typeof MappingCreatedData>;

// click.recorded — emitted by the redirect-bff HTTP handler.
// Sole-producer exception per BRAINSTORM §1: redirect is allowed to
// publish directly because it owns the request.
export const ClickRecordedData = z.object({
  code:       z.string().min(1).max(64),
  ownerUid:   z.string().min(1),
  clickedAt:  z.string().datetime(),
});
export type ClickRecordedData = z.infer<typeof ClickRecordedData>;

// CloudEvent envelope (Cloud Run pushes events in this shape).
// `id` is stable across retries; that is our idempotency key.
export const CloudEvent = z.object({
  id:        z.string().min(1),
  source:    z.string().min(1),
  type:      z.string().min(1),
  time:      z.string().datetime().optional(),
  specversion: z.string().optional(),
  datacontenttype: z.string().optional(),
  data:      z.unknown(),
});
export type CloudEvent = z.infer<typeof CloudEvent>;

// The two event types we recognize on the bus.
export const EventType = {
  MAPPING_CREATED: 'mapping.created',
  CLICK_RECORDED:  'click.recorded',
} as const;
export type EventTypeName = typeof EventType[keyof typeof EventType];

// Helper: parse a CloudEvent's `data` field by event type.
export function parseEventData(type: string, data: unknown) {
  switch (type) {
    case EventType.MAPPING_CREATED:
      return MappingCreatedData.parse(data);
    case EventType.CLICK_RECORDED:
      return ClickRecordedData.parse(data);
    default:
      throw new Error(`Unknown event type: ${type}`);
  }
}
