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
import { getFirestore, createDoc, isAlreadyExistsError } from '@usgcp/firestore';
import { resolveUid } from '@usgcp/auth';
import { publishEvent } from '@usgcp/pubsub';
import { errorResponse, jsonError } from '@usgcp/http';
import { decodeDocumentEventDataBytes } from '@usgcp/proto-decode';
import { z } from 'zod';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const topicName = process.env.EVENTHUB_TOPIC ?? 'url-shortener-events';

const ShortenBody = z.object({
  // Only http(s) — longUrl is later used as a redirect Location.
  longUrl: z.string().url().max(2048).refine(
    (v) => /^https?:\/\//i.test(v),
    { message: 'longUrl must use http or https' },
  ),
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

  // 3. Generate code if absent. Atomic create — no check-then-set race.
  const code = body.code ?? nanoid(8);
  getFirestore({ databaseId: 'app-db' });
  try {
    await createDoc(
      { database: 'app-db', collection: 'mappings' },
      code,
      {
        code,
        longUrl: body.longUrl,
        ownerUid: uid,
        createdAt: new Date().toISOString(),
      },
    );
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return errorResponse(409, 'code_taken', `code ${code} already exists`);
    }
    throw err;
  }

  // Command leg only: authoritative Firestore write. mapping.created is
  // published solely by the Firestore Eventarc trigger leg
  // (POST /__eventarc/publish) — database-first CDC, not dual publish.
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
 * Trigger leg: Firestore CDC (Eventarc) → mapping.created on the bus.
 * Live delivery is CloudEvents binary mode:
 *   ce-* headers + application/protobuf DocumentEventData body.
 */
async function handleFirestoreCreatedFromProtobuf(opts: {
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

  if (!isEventarc) {
    // Keep a cheap probe for non-event POSTs to `/`.
    const probe = await c.req.text();
    if (!(probe.includes('"message"') || probe.includes('"attributes"'))) {
      return c.json({ ack: true, ignored: 'not-eventarc' }, 200);
    }
  }

  // Firestore Eventarc → Cloud Run uses binary CloudEvents: protobuf body + ce-* headers.
  // Do NOT read as text first — UTF-8 decoding corrupts protobuf wire bytes.
  const body = new Uint8Array(await c.req.arrayBuffer());
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

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
