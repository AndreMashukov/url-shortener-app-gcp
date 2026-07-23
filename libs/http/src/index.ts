// libs/http — Hono router + standard error response model + a small
// `okOrNotFound` helper used by the redirect-bff and analytics-bff.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export interface ApiError {
  error: string;
  message?: string;
  detail?: unknown;
}

export function errorResponse(status: number, code: string, message?: string, detail?: unknown): Response {
  const body: ApiError = { error: code };
  if (message !== undefined) body.message = message;
  if (detail !== undefined) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Common error shape used across all three BFFs.
 */
export function jsonError(err: unknown): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  if (err instanceof Error) {
    return errorResponse(500, 'internal_error', err.message);
  }
  return errorResponse(500, 'internal_error', String(err));
}

/**
 * Create a 302 redirect response.
 */
export function redirect(location: string, status: 301 | 302 | 307 | 308 = 302): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

/**
 * Hono app with a `c.json` default helper. The BFFs do
 *   const app = new Hono<{ Variables: { uid: string } }>();
 * rather than use this directly; this file is just for shared helpers.
 */
export function makeApp() {
  return new Hono();
}

export { HTTPException };
