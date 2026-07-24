// Trigger leg — Firestore CDC via Eventarc → mapping.created on the bus.
// Sole producer of mapping.created (database-first pattern).

import type { Env, Hono } from 'hono';
import { publishEvent } from '@usgcp/pubsub';
import { errorResponse } from '@usgcp/http';
import { decodeDocumentEventDataBytes } from '@usgcp/proto-decode';

const topicName = process.env.EVENTHUB_TOPIC ?? 'url-shortener-events';

type TriggerResult =
  | { ack: true; published: 'mapping.created'; code: string; eventId: string }
  | { ack: true; ignored: string; fields?: string[] };

function mappingCodeFromSubject(subject: string): string | null {
  // Eventarc subjects observed/docs vary:
  //   documents/mappings/{code}
  //   projects/.../databases/.../documents/mappings/{code}
  //   mappings/{code}
  const markers = ['/mappings/', 'mappings/'];
  for (const marker of markers) {
    const idx = subject.lastIndexOf(marker);
    if (idx >= 0) {
      const code = subject.slice(idx + marker.length).split('/').filter(Boolean)[0];
      if (code) return code;
    }
  }
  return null;
}

async function publishMappingCreated(opts: {
  eventId: string;
  code: string;
  longUrl: string;
  ownerUid: string;
  createdAt: string;
}): Promise<TriggerResult> {
  await publishEvent({
    topicName,
    eventId: opts.eventId,
    type: 'mapping.created',
    data: {
      code: opts.code,
      longUrl: opts.longUrl,
      ownerUid: opts.ownerUid,
      createdAt: opts.createdAt,
    },
  });
  return {
    ack: true,
    published: 'mapping.created',
    code: opts.code,
    eventId: opts.eventId,
  };
}

/**
 * Live delivery is CloudEvents binary mode:
 *   ce-* headers + application/protobuf DocumentEventData body.
 */
export async function handleFirestoreCreatedFromProtobuf(opts: {
  eventId?: string;
  ceType?: string;
  subject?: string;
  body: Uint8Array;
}): Promise<TriggerResult> {
  const ceType = opts.ceType ?? '';
  if (ceType && ceType !== 'google.cloud.firestore.document.v1.created') {
    return { ack: true, ignored: ceType };
  }

  let decoded;
  try {
    decoded = decodeDocumentEventDataBytes(opts.body);
  } catch (err) {
    console.error('[app-bff] protobuf-decode-failed', String(err));
    return { ack: true, ignored: 'protobuf-decode-failed' };
  }

  const subject = opts.subject || decoded.document.name;
  const code = mappingCodeFromSubject(subject) ?? mappingCodeFromSubject(decoded.path) ?? '';
  if (!code) {
    return { ack: true, ignored: subject ? `no-mapping:${subject}` : 'no-code' };
  }

  const fields = decoded.document.fields;
  const longUrl = fields.longUrl?.stringValue ?? '';
  const ownerUid = fields.ownerUid?.stringValue ?? '';
  const createdAt =
    fields.createdAt?.stringValue ??
    fields.createdAt?.timestampValue ??
    decoded.document.createTime ??
    new Date().toISOString();

  if (!longUrl || !ownerUid) {
    return { ack: true, ignored: 'missing-fields', fields: Object.keys(fields) };
  }

  const eventId = opts.eventId ?? `evt-${code}-${createdAt}`;
  return publishMappingCreated({ eventId, code, longUrl, ownerUid, createdAt });
}

export function registerTriggerRoutes<E extends Env>(app: Hono<E>): void {
  // POST /__eventarc/publish — manual/JSON path for fixtures & local tests.
  app.post('/__eventarc/publish', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('protobuf') || contentType.includes('octet-stream')) {
      const body = new Uint8Array(await c.req.arrayBuffer());
      const result = await handleFirestoreCreatedFromProtobuf({
        eventId: c.req.header('ce-id') ?? undefined,
        ceType: c.req.header('ce-type') ?? 'google.cloud.firestore.document.v1.created',
        subject: c.req.header('ce-subject') ?? undefined,
        body,
      });
      console.log('[app-bff] firestore-trigger', JSON.stringify(result));
      return c.json(result, 200);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch (err) {
      return errorResponse(400, 'invalid_json', String(err));
    }

    // Accept either a CloudEvent JSON envelope or a raw DocumentEventData JSON view.
    const ceType = body.type ?? 'google.cloud.firestore.document.v1.created';
    const subject = body.subject ?? body.data?.value?.name ?? body.value?.name ?? '';
    if (ceType !== 'google.cloud.firestore.document.v1.created') {
      return c.json({ ack: true, ignored: ceType }, 200);
    }
    const code = mappingCodeFromSubject(subject);
    if (!code) {
      return c.json({ ack: true, ignored: subject ? `no-mapping:${subject}` : 'no-subject' }, 200);
    }
    const fields = body.data?.value?.fields ?? body.value?.fields ?? {};
    const longUrl = fields.longUrl?.stringValue ?? '';
    const ownerUid = fields.ownerUid?.stringValue ?? '';
    const createdAt =
      fields.createdAt?.stringValue ??
      fields.createdAt?.timestampValue ??
      new Date().toISOString();
    if (!longUrl || !ownerUid) {
      return c.json({ ack: true, ignored: 'missing-fields', fields: Object.keys(fields) }, 200);
    }
    const eventId = body.id ?? `evt-${code}-${createdAt}`;
    const result = await publishMappingCreated({ eventId, code, longUrl, ownerUid, createdAt });
    console.log('[app-bff] firestore-trigger', JSON.stringify(result));
    return c.json(result, 200);
  });

  // Catch-all for Eventarc CloudEvents binary / CE_PUBSUB_BINDING pushes to `/`.
  app.post('/', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    const ceHeaders = {
      id: c.req.header('ce-id') ?? c.req.header('Ce-Id') ?? undefined,
      type: c.req.header('ce-type') ?? c.req.header('Ce-Type') ?? undefined,
      subject: c.req.header('ce-subject') ?? c.req.header('Ce-Subject') ?? undefined,
    };
    const isEventarc =
      Boolean(ceHeaders.type) ||
      contentType.includes('protobuf') ||
      Boolean(c.req.query('__GCP_CloudEventsMode'));

    // Read raw bytes once. Never probe with text() first — Hono would rebuild
    // a later arrayBuffer() from UTF-8-cached text and corrupt protobuf.
    const body = new Uint8Array(await c.req.arrayBuffer());

    if (!isEventarc) {
      const probe = Buffer.from(body).toString('utf8');
      if (!(probe.includes('"message"') || probe.includes('"attributes"'))) {
        return c.json({ ack: true, ignored: 'not-eventarc' }, 200);
      }
    }

    console.log('[app-bff] eventarc-body', JSON.stringify({
      len: body.byteLength,
      contentType,
      ceHeaders,
    }));

    const result = await handleFirestoreCreatedFromProtobuf({
      eventId: ceHeaders.id,
      ceType: ceHeaders.type,
      subject: ceHeaders.subject,
      body,
    });
    console.log('[app-bff] eventarc', JSON.stringify(result));
    return c.json(result, 200);
  });
}
