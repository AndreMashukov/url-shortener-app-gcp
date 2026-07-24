// apps/redirect-bff — real handler.
//
// Routes:
//   GET  /:code                -> reads lean_view/{code} from redirect-db,
//                                  302 to the longUrl. Publishes
//                                  click.recorded to the bus (sole-producer
//                                  exception per BRAINSTORM §1).
//   POST /__eventarc/publish    -> Eventarc bus trigger receiver.
//                                  On mapping.created, upserts
//                                  redirect-db/lean_view/{code}.
//   POST /?__GCP_CloudEventsMode=… -> Eventarc entrypoint (same handler)
//   GET  /                      health
//   GET  /info                  env info
//
// Per BRAINSTORM §1: the redirect is allowed to publish click.recorded
// directly. mapping.created is consumed from the bus, never published.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getFirestore, getDoc, upsertDoc } from '@usgcp/firestore';
import { publishEvent } from '@usgcp/pubsub';
import { errorResponse, jsonError, redirect as redirectResponse } from '@usgcp/http';

const projectId = process.env.GCP_PROJECT_ID ?? '';
const topicName = process.env.EVENTHUB_TOPIC ?? 'url-shortener-events';
const leanCollection = { database: 'redirect-db', collection: 'lean_view' } as const;

const app = new Hono();

app.get('/', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'redirect-bff',
  status: 'ok',
}));

app.get('/info', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'redirect-bff',
  project: projectId,
  region: process.env.GCP_REGION ?? 'unknown',
  node: process.version,
  env: process.env.ENV ?? 'dev',
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

// GET /:code — redirect to the longUrl
app.get('/:code', async (c) => {
  const code = c.req.param('code');
  if (!code || code.length > 64) {
    return errorResponse(400, 'invalid_code');
  }

  getFirestore({ databaseId: 'redirect-db' });

  const lean = await getDoc<{ longUrl: string; ownerUid: string }>(leanCollection, code);
  if (!lean) {
    return errorResponse(404, 'not_found', `code ${code} not yet available`);
  }

  publishEvent({
    topicName,
    eventId: `click-${code}-${Date.now()}`,
    type: 'click.recorded',
    data: {
      code,
      ownerUid: lean.ownerUid,
      clickedAt: new Date().toISOString(),
    },
  }).catch((err) => {
    console.error(`[redirect-bff] click.recorded publish failed for code=${code}:`, err);
  });

  return redirectResponse(lean.longUrl, 302);
});

type BusResult =
  | { ack: true; upserted: string }
  | { ack: true; ignored: string };

async function handleBusEvent(body: any): Promise<BusResult> {
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

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
