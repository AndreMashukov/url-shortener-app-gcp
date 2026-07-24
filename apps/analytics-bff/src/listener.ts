// Listener leg — bus consumer for click.recorded → create-or-increment clicks.
// Seed-on-first-click; ignores mapping.created (AWS parity).

import type { Env, Hono } from 'hono';
import { getFirestore, incrementOrCreate } from '@usgcp/firestore';
import { errorResponse } from '@usgcp/http';

const clicksCollection = { database: 'analytics-db', collection: 'clicks' } as const;

type BusResult =
  | { ack: true; incremented: string }
  | { ack: true; ignored: string; eventType?: string; keys?: string[] };

/**
 * Handle a bus event from Eventarc / direct invoke.
 * AWS parity: seed analytics on first click.recorded only.
 */
export async function handleBusEvent(body: any): Promise<BusResult> {
  // A) CUSTOM_PUBSUB { message: { data, attributes } }
  // B) CloudEvents JSON { data: { message: { data, attributes } } }
  // C) Decoded event { id, type, data }
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
      return { ack: true, ignored: 'decode-failed', keys: Object.keys(body ?? {}) };
    }
    eventType = attrs.type ?? payload?.type ?? '';
    eventData = payload?.data ?? payload ?? {};
  } else if (body?.data && typeof body.data === 'object' && body.type) {
    eventType = String(body.type);
    eventData = body.data;
  } else {
    return {
      ack: true,
      ignored: 'unknown-shape',
      keys: Object.keys(body ?? {}),
      eventType: body?.type,
    };
  }

  const code = eventData.code as string | undefined;
  const ownerUid = eventData.ownerUid as string | undefined;
  if (!code || !ownerUid) {
    return { ack: true, ignored: 'missing-fields', eventType };
  }

  getFirestore({ databaseId: 'analytics-db' });

  if (eventType === 'click.recorded') {
    const lastClickAt = (eventData.clickedAt as string | undefined)
      ?? new Date().toISOString();
    // Atomic create-or-increment: never reset an existing count on
    // transient errors (narrow catch / merge+increment).
    await incrementOrCreate(clicksCollection, code, 'count', 1, {
      code,
      ownerUid,
      lastClickAt,
    });
    return { ack: true, incremented: code };
  }

  return { ack: true, ignored: eventType };
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
    console.log('[analytics-bff] bus', JSON.stringify(result));
    return c.json(result, 200);
  });

  // Eventarc pushes to /?__GCP_CloudEventsMode=CUSTOM_PUBSUB_…
  // Note: Hono/Node often sees url WITHOUT the query string, so do not
  // require __GCP_CloudEventsMode — detect Pub/Sub push envelopes instead.
  app.post('/', async (c) => {
    const bodyText = await c.req.text();
    const looksLikePush = bodyText.includes('"message"') || bodyText.includes('"attributes"');
    if (!looksLikePush && !c.req.query('__GCP_CloudEventsMode')) {
      return c.json({ ack: true, ignored: 'not-eventarc' }, 200);
    }

    let body: any;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch (err) {
      console.error('[analytics-bff] eventarc-invalid-json', String(err));
      return c.json({ ack: true, ignored: 'invalid-json' }, 200);
    }

    const result = await handleBusEvent(body);
    console.log('[analytics-bff] eventarc', JSON.stringify(result));
    return c.json(result, 200);
  });
}
