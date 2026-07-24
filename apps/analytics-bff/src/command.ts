// Command leg — synchronous analytics HTTP API (read-only).

import type { Env, Hono } from 'hono';
import { getFirestore, getDoc } from '@usgcp/firestore';
import { resolveUid } from '@usgcp/auth';
import { errorResponse } from '@usgcp/http';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const clicksCollection = { database: 'analytics-db', collection: 'clicks' } as const;

export function registerCommandRoutes<E extends Env>(app: Hono<E>): void {
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
}
