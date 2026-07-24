// apps/app-bff — thin entrypoint.
//
// Roles (book terminology):
//   command.ts  — sync HTTP (POST /shorten, GET /me/urls)
//   trigger.ts  — Firestore CDC → mapping.created (sole producer)
//
// Per BRAINSTORM §1: /shorten does NOT publish mapping.created.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { jsonError } from '@usgcp/http';
import { registerCommandRoutes } from './command.js';
import { registerTriggerRoutes } from './trigger.js';

const projectId = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';

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

registerCommandRoutes(app);
registerTriggerRoutes(app);

app.onError((err, c) => jsonError(err));

const port = Number(process.env.PORT ?? 8080);
console.log(`listening on :${port}`);
serve({ fetch: app.fetch, port });
