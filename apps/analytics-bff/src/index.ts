// apps/analytics-bff — real handler.
//
// Routes:
//   GET  /analytics/:code      (auth) -> reads analytics-db/clicks/{code},
//                                  404 if no clicks yet (AWS parity),
//                                  403 if the caller's uid does not match
//                                  the denormalized ownerUid.
//   POST /__eventarc/publish    -> bus trigger receiver. Handles:
//                                    click.recorded: create-or-increment
//                                    (seed-on-first-click; ignores mapping.created)
//   POST /?__GCP_CloudEventsMode=… -> Eventarc entrypoint (same handler)
//   GET  /                      health
//   GET  /info                  env info
//
// Per BRAINSTORM §1: analytics NEVER cross-reads other databases.
// `ownerUid` is denormalized onto the clicks doc from click.recorded.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getFirestore, getDoc, incrementOrCreate } from '@usgcp/firestore';
import { resolveUid } from '@usgcp/auth';
import { errorResponse, jsonError } from '@usgcp/http';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const clicksCollection = { database: 'analytics-db', collection: 'clicks' } as const;

const app = new Hono<{ Variables: { uid: string } }>();

app.get('/', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'analytics-bff',
  status: 'ok',
}));

app.get('/info', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'analytics-bff',
  project: projectId,
  region: process.env.GCP_REGION ?? 'unknown',
  node: process.version,
  env: process.env.ENV ?? 'dev',
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

// GET /analytics/:code — owner-only click count
app.get('/analytics/:code', async (c) => {
  const code = c.req.param('code');
  if (!code || code.length > 64) {
    return errorResponse(400, 'invalid_code');
  }

  let uid: string;
  try {
    const result = await resolveUid({
      smokeHeader: c.req.header('x-smoke-test'),
      authorization: c.req.header('authorization'),
      projectId,
    });
    if ('error' in result) {
      return errorResponse(401, result.error, result.message);
    }
    uid = result.uid;
  } catch (err) {
    return errorResponse(401, 'invalid_token', String(err));
  }

  getFirestore({ databaseId: 'analytics-db' });

  const clicks = await getDoc<{
    code: string;
    ownerUid: string;
    count: number;
    lastClickAt?: string;
  }>(clicksCollection, code);

  if (!clicks) {
    return errorResponse(404, 'not_found', `no analytics for code ${code}`);
  }

  if (clicks.ownerUid !== uid) {
    return errorResponse(403, 'forbidden', 'not the owner');
  }

  return c.json({
    code: clicks.code,
    ownerUid: clicks.ownerUid,
    count: clicks.count ?? 0,
    lastClickAt: clicks.lastClickAt ?? null,
  });
});

type BusResult =
  | { ack: true; incremented: string }
  | { ack: true; ignored: string; eventType?: string; keys?: string[] };

/**
 * Handle a bus event from Eventarc / direct invoke.
 * AWS parity: seed analytics on first click.recorded only.
 */
async function handleBusEvent(body: any): Promise<BusResult> {
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

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
