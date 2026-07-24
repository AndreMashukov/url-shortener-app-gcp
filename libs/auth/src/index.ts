// libs/auth — Identity Platform JWT verify middleware.
//
// On AWS the app used Cognito's user-pool JWKS. On GCP we use the
// Firebase Auth / Identity Platform JWKS at
//   https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
// discovered from
//   https://securetoken.google.com/<PROJECT_ID>/.well-known/openid-configuration.
//
// We expose two things:
//   - `verifyIdToken(token, projectId)` — returns the decoded claims
//     or throws.
//   - `requireAuth(projectId)` — a Hono middleware that pulls a Bearer
//     token from `Authorization`, verifies it, and sets `c.set('uid', uid)`.
//
// Dev/smoke escape hatch (gated by env):
//   When `SMOKE_TEST_KEY` is set on the service AND the request carries
//   a matching `X-Smoke-Test` header, JWT verify is skipped and the
//   fixed uid `smoke-test-user` is used. Unset the env var in prod.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler, Context } from 'hono';

const SECURETOKEN_JWKS: JWTVerifyGetKey = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
  { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000 },
);

/** Fixed uid used when the X-Smoke-Test bypass is active. */
export const SMOKE_TEST_UID = 'smoke-test-user';

export interface AuthClaims extends JWTPayload {
  // Identity Platform's standard claims:
  sub: string;            // user UID (this is the "owner" identifier)
  email?: string;
  email_verified?: boolean;
  auth_time?: number;
  // Custom claims (optional)
  [key: string]: unknown;
}

/**
 * If SMOKE_TEST_KEY is set and the X-Smoke-Test header matches it,
 * return the fixed smoke uid. Otherwise return null (caller must JWT-verify).
 * Inert when ENV/NODE_ENV is production — defense in depth if the secret
 * is accidentally left on a prod revision.
 */
export function uidFromSmokeHeader(header: string | undefined): string | null {
  const key = process.env.SMOKE_TEST_KEY;
  if (!key || !header) return null;
  if (process.env.ENV === 'production' || process.env.NODE_ENV === 'production') {
    return null;
  }
  if (header === key) return SMOKE_TEST_UID;
  return null;
}

/**
 * Verify an Identity Platform ID token.
 * `projectId` is the GCP project ID (used as `aud`).
 */
export async function verifyIdToken(token: string, projectId: string): Promise<AuthClaims> {
  const { payload } = await jwtVerify<AuthClaims>(token, SECURETOKEN_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub) {
    throw new Error('Identity Platform token has no sub claim');
  }
  return payload;
}

/**
 * Extracts a Bearer token from the Authorization header.
 * Returns null if missing or malformed.
 */
function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const [scheme, value] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}

export type AuthContext = Context<{ Variables: { uid: string; claims: AuthClaims } }>;

/**
 * Resolve the caller uid from either the smoke-test bypass or a Bearer
 * Identity Platform ID token. Throws / returns structured failures via
 * the optional error callbacks used by inline handlers.
 */
export async function resolveUid(
  opts: {
    smokeHeader: string | undefined;
    authorization: string | undefined;
    projectId: string;
  },
): Promise<{ uid: string; claims: AuthClaims } | { error: 'missing_bearer_token' | 'invalid_token'; message?: string }> {
  const smokeUid = uidFromSmokeHeader(opts.smokeHeader);
  if (smokeUid) {
    const claims = { sub: smokeUid } as AuthClaims;
    return { uid: smokeUid, claims };
  }

  const token = extractBearer(opts.authorization);
  if (!token) {
    return { error: 'missing_bearer_token' };
  }
  try {
    const claims = await verifyIdToken(token, opts.projectId);
    return { uid: claims.sub, claims };
  } catch (err) {
    return {
      error: 'invalid_token',
      message: err instanceof Error ? err.message : 'verification failed',
    };
  }
}

/**
 * Hono middleware that verifies the bearer token. On success sets
 * `c.var.uid` (the user UID) and `c.var.claims`. On failure responds 401.
 *
 * When SMOKE_TEST_KEY is set and X-Smoke-Test matches, skips JWT verify
 * and sets uid to `smoke-test-user`.
 */
export function requireAuth(projectId: string): MiddlewareHandler<{ Variables: { uid: string; claims: AuthClaims } }> {
  return async (c, next) => {
    const result = await resolveUid({
      smokeHeader: c.req.header('x-smoke-test'),
      authorization: c.req.header('authorization'),
      projectId,
    });
    if ('error' in result) {
      return c.json(
        { error: result.error, message: result.message },
        401,
      );
    }
    c.set('uid', result.uid);
    c.set('claims', result.claims);
    await next();
  };
}
