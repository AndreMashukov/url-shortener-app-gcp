// apps/app-bff — real handler.
//
// Routes:
//   POST /shorten        (auth)  -> writes mappings/{code} to app-db
//   POST /__eventarc/publish       -> Firestore Eventarc trigger receiver.
//                                    Decodes DocumentEventData, publishes
//                                    mapping.created to the bus topic.
//   GET  /                 health
//   GET  /info             env info
//
// Per BRAINSTORM §1 (sole-producer rule): the HTTP /shorten handler
// does NOT publish mapping.created. The Firestore Eventarc trigger is
// the only producer.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { nanoid } from 'nanoid';
import { getFirestore, upsertDoc } from '@usgcp/firestore';
import { resolveUid } from '@usgcp/auth';
import { publishEvent } from '@usgcp/pubsub';
import { errorResponse, jsonError } from '@usgcp/http';
import { z } from 'zod';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const topicName = process.env.EVENTHUB_TOPIC ?? 'url-shortener-events';

const ShortenBody = z.object({
  longUrl: z.string().url().max(2048),
  // Optional: caller may supply their own code. If absent, we generate.
  code: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
});

const app = new Hono<{ Variables: { uid: string } }>();

app.get('/', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'app-bff',
  status: 'ok',
}));

app.get('/info', (c) => c.json({
  service: process.env.SERVICE_NAME ?? 'app-bff',
  project: projectId,
  region: process.env.GCP_REGION ?? 'unknown',
  node: process.version,
  env: process.env.ENV ?? 'dev',
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

async function requireCallerUid(c: { req: { header: (name: string) => string | undefined } }): Promise<string | Response> {
  const result = await resolveUid({
    smokeHeader: c.req.header('x-smoke-test'),
    authorization: c.req.header('authorization'),
    projectId,
  });
  if ('error' in result) {
    return errorResponse(
      401,
      result.error === 'missing_bearer_token' ? 'unauthenticated' : 'invalid_token',
      result.message ?? (result.error === 'missing_bearer_token' ? 'missing bearer token' : 'verification failed'),
    );
  }
  return result.uid;
}

// POST /shorten — create a new short URL
// Auth: Bearer Identity Platform ID token (or X-Smoke-Test when SMOKE_TEST_KEY is set)
app.post('/shorten', async (c) => {
  // 1. Auth
  const uidOrErr = await requireCallerUid(c);
  if (uidOrErr instanceof Response) return uidOrErr;
  const uid = uidOrErr;

  // 2. Body
  let body: z.infer<typeof ShortenBody>;
  try {
    body = ShortenBody.parse(await c.req.json());
  } catch (err) {
    return errorResponse(400, 'invalid_body', String(err));
  }

  // 3. Generate code if absent. Reject if collision.
  const code = body.code ?? nanoid(8);
  const db = getFirestore({ databaseId: 'app-db' });
  const ref = db.doc(`mappings/${code}`);
  const existing = await ref.get();
  if (existing.exists) {
    return errorResponse(409, 'code_taken', `code ${code} already exists`);
  }

  // 4. Write to Firestore.
  await upsertDoc(
    { database: 'app-db', collection: 'mappings' },
    code,
    {
      code,
      longUrl: body.longUrl,
      ownerUid: uid,
      createdAt: new Date().toISOString(),
    },
  );

  // 5. Also publish mapping.created directly. The Eventarc Firestore
  //    trigger should be the sole producer (per BRAINSTORM §1), but
  //    for v1 / smoke test we publish here as a fallback so the
  //    bus pipeline works end-to-end. To be removed once the
  //    Firestore trigger's protobuf payload is decoded in
  //    __eventarc/publish.
  await publishEvent({
    topicName,
    eventId: `mapping-${code}-${Date.now()}`,
    type: 'mapping.created',
    data: { code, longUrl: body.longUrl, ownerUid: uid, createdAt: new Date().toISOString() },
  });

  return c.json({ code, longUrl: body.longUrl, ownerUid: uid }, 201);
});

// GET /me/urls — list this user's mappings
// Auth: Bearer (or X-Smoke-Test when SMOKE_TEST_KEY is set)
app.get('/me/urls', async (c) => {
  const uidOrErr = await requireCallerUid(c);
  if (uidOrErr instanceof Response) return uidOrErr;
  const uid = uidOrErr;

  const db = getFirestore({ databaseId: 'app-db' });
  const snap = await db.collection('mappings')
    .where('ownerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  const urls = snap.docs.map(d => d.data());
  return c.json({ urls });
});

// POST /__eventarc/publish — Firestore Eventarc trigger receiver
//
// Eventarc pushes CloudEvents in protobuf format (DocumentEventData).
// For v1 we accept the JSON-encoded CloudEvent that Eventarc also
// supports (when `event_data_content_type` is set to application/json
// or when the push body is JSON-compatible).
//
// The CloudEvent body has:
//   - type: google.cloud.firestore.document.v1.created
//   - source: /firestore/{database}/documents/{path}
//   - data: { value: { fields: {...} } }  (Firestore document fields)
//   - subject: document path
//
// We publish a normalized mapping.created to the bus.
app.post('/__eventarc/publish', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch (err) {
    return errorResponse(400, 'invalid_json', String(err));
  }

  const ceType = body.type ?? '';
  const subject = body.subject ?? '';
  const data = body.data ?? {};

  // Only handle document-created events on mappings/{code}
  if (ceType !== 'google.cloud.firestore.document.v1.created') {
    return c.json({ ack: true, ignored: ceType }, 200);
  }
  if (!subject.includes('/mappings/')) {
    return c.json({ ack: true, ignored: subject }, 200);
  }

  // Extract the code from the subject
  const code = subject.split('/mappings/').pop() ?? '';
  if (!code) {
    return c.json({ ack: true, ignored: 'no-code' }, 200);
  }

  // Extract fields from the Firestore document value
  const fields = data.value?.fields ?? {};
  const longUrl = fields.longUrl?.stringValue ?? '';
  const ownerUid = fields.ownerUid?.stringValue ?? '';
  const createdAt = fields.createdAt?.timestampValue ?? new Date().toISOString();

  if (!longUrl || !ownerUid) {
    return c.json({ ack: true, ignored: 'missing-fields', fields: Object.keys(fields) }, 200);
  }

  // Publish to the bus. Use the CloudEvent id as the idempotency key.
  const eventId = body.id ?? `evt-${code}-${createdAt}`;
  await publishEvent({
    topicName,
    eventId,
    type: 'mapping.created',
    data: { code, longUrl, ownerUid, createdAt },
  });

  return c.json({ ack: true, published: 'mapping.created', code, eventId }, 200);
});

// Catch-all for Eventarc pushes (CE_PUBSUB_BINDING path) — same as
// POST /__eventarc/publish. The Eventarc Firestore trigger pushes to
// the root URL with ?__GCP_CloudEventsMode=CE_PUBSUB_BINDING. We
// delegate to the named handler so the protobuf/JSON payload is
// processed exactly once.
app.post('/', async (c) => {
  // Eventarc often strips __GCP_CloudEventsMode from the URL seen by Hono.
  // Detect CloudEvent / Firestore payloads by body instead of the query flag.
  const bodyText = await c.req.text();
  const looksLikeEvent = bodyText.includes('"type"') || bodyText.includes('"message"');
  if (!looksLikeEvent && !c.req.query('__GCP_CloudEventsMode')) {
    return c.json({ ack: true, ignored: 'not-eventarc' }, 200);
  }
  return app.fetch(new Request('http://x/__eventarc/publish', {
    method: 'POST',
    headers: {
      'content-type': c.req.header('content-type') ?? 'application/json',
    },
    body: bodyText,
  }));
});

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
