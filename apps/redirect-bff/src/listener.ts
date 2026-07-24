// Listener leg — bus consumer for mapping.created → lean_view upsert.

import type { Env, Hono } from 'hono';
import { getFirestore, upsertDoc } from '@usgcp/firestore';
import { errorResponse } from '@usgcp/http';

const leanCollection = { database: 'redirect-db', collection: 'lean_view' } as const;

type BusResult =
  | { ack: true; upserted: string }
  | { ack: true; ignored: string };

export async function handleBusEvent(body: any): Promise<BusResult> {
  const ceType = body?.type ?? '';
  const envelope = body?.data?.message ?? body?.message;
  let eventType = '';
  let eventData: Record<string, unknown> = {};

  if (envelope && envelope.data != null) {
    const attrs = envelope.attributes ?? {};
    let payload: any;
    try {
      const raw = envelope.data;
      payload = typeof raw === 'string'
        ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
        : raw;
    } catch {
      return { ack: true, ignored: 'decode-failed' };
    }
    eventType = attrs.type ?? payload?.type ?? '';
    eventData = payload?.data ?? payload ?? {};
  } else if (body?.data && typeof body.data === 'object' && body.type) {
    // If CE type is the Pub/Sub platform type, dig for message; else treat as domain event.
    if (String(body.type).includes('pubsub') && body.data.message) {
      return handleBusEvent({ message: body.data.message });
    }
    eventType = String(body.type);
    eventData = body.data;
  } else {
    return { ack: true, ignored: ceType || 'unknown-shape' };
  }

  if (eventType !== 'mapping.created') {
    return { ack: true, ignored: eventType || ceType };
  }

  const code = eventData.code as string | undefined;
  const longUrl = eventData.longUrl as string | undefined;
  const ownerUid = eventData.ownerUid as string | undefined;
  if (!code || !longUrl || !ownerUid) {
    return { ack: true, ignored: 'missing-fields' };
  }

  getFirestore({ databaseId: 'redirect-db' });
  await upsertDoc(leanCollection, code, {
    code,
    longUrl,
    ownerUid,
    createdAt: eventData.createdAt ?? new Date().toISOString(),
  });

  return { ack: true, upserted: code };
}

export function registerListenerRoutes<E extends Env>(app: Hono<E>): void {
  app.post('/__eventarc/publish', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch (err) {
      return errorResponse(400, 'invalid_json', String(err));
    }
    const result = await handleBusEvent(body);
    console.log('[redirect-bff] bus', JSON.stringify(result));
    return c.json(result, 200);
  });

  app.post('/', async (c) => {
    // Eventarc query string is often stripped from c.req.url under Node;
    // detect Pub/Sub push envelopes by body shape instead.
    const bodyText = await c.req.text();
    const looksLikePush = bodyText.includes('"message"') || bodyText.includes('"attributes"');
    if (!looksLikePush && !c.req.query('__GCP_CloudEventsMode')) {
      return c.json({ ack: true, ignored: 'not-eventarc' }, 200);
    }

    let body: any;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (err) {
      console.error('[redirect-bff] eventarc-invalid-json', String(err));
      return c.json({ ack: true, ignored: 'invalid-json' }, 200);
    }

    const result = await handleBusEvent(body);
    console.log('[redirect-bff] eventarc', JSON.stringify(result));
    return c.json(result, 200);
  });
}
