// Command leg — synchronous redirect HTTP API.
// Publishes click.recorded (documented sole-producer exception).

import type { Env, Hono } from 'hono';
import { getFirestore, getDoc } from '@usgcp/firestore';
import { publishEvent } from '@usgcp/pubsub';
import { errorResponse, redirect as redirectResponse } from '@usgcp/http';

const topicName = process.env.EVENTHUB_TOPIC ?? 'url-shortener-events';
const leanCollection = { database: 'redirect-db', collection: 'lean_view' } as const;

export function registerCommandRoutes<E extends Env>(app: Hono<E>): void {
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
}
