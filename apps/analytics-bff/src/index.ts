// apps/analytics-bff — thin entrypoint.
//
// Roles (book terminology):
//   command.ts   — GET /analytics/:code (auth, owner-only read)
//   listener.ts  — bus click.recorded → create-or-increment
//
// No Firestore CDC trigger in this BFF. Never cross-reads other DBs.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { jsonError } from '@usgcp/http';
import { registerCommandRoutes } from './command.js';
import { registerListenerRoutes } from './listener.js';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';

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

registerListenerRoutes(app);
registerCommandRoutes(app);

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
