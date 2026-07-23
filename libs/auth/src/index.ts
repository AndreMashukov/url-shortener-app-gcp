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

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler, Context } from 'hono';

const SECURETOKEN_JWKS: JWTVerifyGetKey = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
  { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000 },
);

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
 * Hono middleware that verifies the bearer token. On success sets
 * `c.var.uid` (the user UID) and `c.var.claims`. On failure responds 401.
 */
export function requireAuth(projectId: string): MiddlewareHandler<{ Variables: { uid: string; claims: AuthClaims } }> {
  return async (c, next) => {
    const token = extractBearer(c.req.header('authorization'));
    if (!token) {
      return c.json({ error: 'missing_bearer_token' }, 401);
    }
    try {
      const claims = await verifyIdToken(token, projectId);
      c.set('uid', claims.sub);
      c.set('claims', claims);
      await next();
    } catch (err) {
      return c.json(
        { error: 'invalid_token', message: err instanceof Error ? err.message : 'verification failed' },
        401,
      );
    }
  };
}
