// apps/redirect-bff — thin entrypoint.
//
// Roles (book terminology):
//   command.ts   — GET /:code → 302 (+ click.recorded publish exception)
//   listener.ts  — bus mapping.created → lean_view upsert
//
// No Firestore CDC trigger in this BFF.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { jsonError } from '@usgcp/http';
import { registerCommandRoutes } from './command.js';
import { registerListenerRoutes } from './listener.js';

const projectId = process.env.GCP_PROJECT_ID ?? '';

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

registerListenerRoutes(app);
registerCommandRoutes(app);

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
