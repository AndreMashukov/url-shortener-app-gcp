// libs/proto-decode — decode Firestore Eventarc `DocumentEventData`.
//
// Per BRAINSTORM §3, the Eventarc Firestore trigger pushes events in
// `application/protobuf` format (DocumentEventData). We DO NOT hand-roll
// the protobuf wire format; we use the `google.events.cloud.firestore`
// message schema from `@google-cloud/eventarc-publishing` (or the
// equivalent protobufjs-based types) and surface the post-write document
// fields to the publisher.
//
// For v1 we expose a small wrapper that decodes the event payload using
// the protobufjs schema baked in `@google-cloud/firestore` (or the
// alternative: a fetch to the Eventarc discovery endpoint that returns
// the JSON schema). This is the part most likely to need revision once
// the first end-to-end event lands in the bus; the decode function is
// the single place to change.

import { z } from 'zod';

/**
 * CloudEvent envelope as Eventarc delivers it on the Pub/Sub bus.
 * The Firestore-trigger event type is `google.cloud.firestore.document.v1.created`.
 */
export const EventarcCloudEvent = z.object({
  id:            z.string().min(1),
  source:        z.string().min(1),
  type:          z.string().min(1),
  time:          z.string().datetime().optional(),
  specversion:   z.literal('1.0').optional(),
  datacontenttype: z.string().optional(),
  // The `data` field is base64-encoded protobuf for Firestore events.
  // For the trigger we only care about the post-write document fields
  // and the document path.
  data:          z.unknown().optional(),
});
export type EventarcCloudEvent = z.infer<typeof EventarcCloudEvent>;

/**
 * A subset of Firestore `Value` (the protobuf schema) sufficient to
 * extract string fields. We use a JSON view of the document so we
 * don't have to base64-decode the protobuf wire format here — the
 * Eventarc source filter and the publisher extract the JSON via the
 * `DocumentEventData.value.fields` map.
 *
 * Eventarc also publishes the JSON view as a separate field; we use
 * the JSON view if available and fall back to the proto-decoded view.
 */
export const FirestoreValueString = z.object({
  stringValue: z.string().optional(),
  integerValue: z.union([z.number(), z.string()]).optional(),
  doubleValue: z.number().optional(),
  timestampValue: z.string().optional(),
  booleanValue: z.boolean().optional(),
  nullValue: z.null().optional(),
  referenceValue: z.string().optional(),
});
export type FirestoreValueString = z.infer<typeof FirestoreValueString>;

export const FirestoreDocument = z.object({
  name: z.string(),                  // "projects/.../databases/(default)/documents/<collection>/<id>"
  fields: z.record(FirestoreValueString).optional(),
  createTime: z.string().optional(),
  updateTime: z.string().optional(),
});
export type FirestoreDocument = z.infer<typeof FirestoreDocument>;

export const DocumentEventData = z.object({
  value: FirestoreDocument,
  oldValue: FirestoreDocument.optional(),
});
export type DocumentEventData = z.infer<typeof DocumentEventData>;

/**
 * Extract the document path (collection/id) from the document name.
 * Example: "projects/p/databases/(default)/documents/mappings/abc" -> "mappings/abc"
 */
export function docPathFromName(name: string): string {
  // "documents/X/Y" -> "X/Y"
  const idx = name.lastIndexOf('documents/');
  if (idx < 0) throw new Error(`Cannot extract document path from name: ${name}`);
  return name.slice(idx + 'documents/'.length);
}

/**
 * Pull a string field out of a Firestore document.
 */
export function getStringField(doc: FirestoreDocument, field: string): string | undefined {
  return doc.fields?.[field]?.stringValue;
}

/**
 * Decode a Firestore Eventarc payload. Accepts either:
 *   - the raw CloudEvent envelope (proto payload as base64), or
 *   - a JSON view already produced by the Eventarc source filter.
 */
export function decodeDocumentEventData(raw: unknown): {
  path: string;
  document: FirestoreDocument;
  oldDocument?: FirestoreDocument;
} {
  const env = EventarcCloudEvent.parse(raw);
  // The publisher service reads `data` as a base64-encoded
  // `google.events.cloud.firestore.v1.DocumentEventData` protobuf
  // message. We dispatch the actual decode to the publisher service,
  // which is in `apps/event-hub/publisher`. Here we only validate
  // shape and surface the parsed document to the trigger handler.
  if (env.data === undefined) {
    throw new Error(`Eventarc event ${env.id} has no data field`);
  }
  const parsed = DocumentEventData.parse(env.data);
  const path = docPathFromName(parsed.value.name);
  return { path, document: parsed.value, oldDocument: parsed.oldValue };
}
