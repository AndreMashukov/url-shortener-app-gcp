// Command leg — synchronous HTTP API.
// Writes/reads app-db only. Does NOT publish mapping.created
// (Firestore Eventarc trigger is the sole producer).

import type { Env, Hono } from 'hono';
import { nanoid } from 'nanoid';
import { getFirestore, createDoc, isAlreadyExistsError } from '@usgcp/firestore';
import { resolveUid } from '@usgcp/auth';
import { errorResponse } from '@usgcp/http';
import { z } from 'zod';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';

const ShortenBody = z.object({
  // Only http(s) — longUrl is later used as a redirect Location.
  longUrl: z.string().url().max(2048).refine(
    (v) => /^https?:\/\//i.test(v),
    { message: 'longUrl must use http or https' },
  ),
  // Optional: caller may supply their own code. If absent, we generate.
  code: z.string().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
});

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

export function registerCommandRoutes<E extends Env>(app: Hono<E>): void {
  // POST /shorten — create a new short URL
  app.post('/shorten', async (c) => {
    const uidOrErr = await requireCallerUid(c);
    if (uidOrErr instanceof Response) return uidOrErr;
    const uid = uidOrErr;

    let body: z.infer<typeof ShortenBody>;
    try {
      body = ShortenBody.parse(await c.req.json());
    } catch (err) {
      return errorResponse(400, 'invalid_body', String(err));
    }

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
    // published solely by the Firestore Eventarc trigger leg.
    return c.json({ code, longUrl: body.longUrl, ownerUid: uid }, 201);
  });

  // GET /me/urls — list this user's mappings
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
}
