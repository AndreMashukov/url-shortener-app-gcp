// libs/firestore — Firestore client factory + small collection helpers.
//
// One client per process, pointed at a single database. Each BFF
// passes its database id via `getFirestore({ databaseId: 'app-db' })`
// at startup. We never instantiate per-request.
//
// BFF ownership: each BFF points at its own database (e.g. `app-db`,
// `redirect-db`, `analytics-db`). This file provides the client
// factory and a thin `getDoc/upsertDoc/incrementField` wrapper that
// uses the document path as the natural idempotency key for at-least-once
// delivery.

import { Firestore, FieldValue, type Settings } from '@google-cloud/firestore';

let _client: Firestore | null = null;
let _databaseId: string | null = null;

/**
 * Get or create the Firestore client for a specific named database.
 * If the same database is requested twice, returns the cached client.
 * If a different database is requested, replaces the cached client.
 *
 * In Cloud Run the runtime SA has roles/datastore.user on the
 * project's databases; no explicit credentials are needed in code.
 */
export function getFirestore(opts?: { databaseId?: string } & Partial<Settings>): Firestore {
  // When called with no databaseId, reuse the already-bound client
  // (helpers like upsertDoc call getFirestore() after the BFF bound the DB).
  // Only fall back to '(default)' when nothing has been bound yet.
  const dbId = opts?.databaseId ?? _databaseId ?? '(default)';
  if (_client && _databaseId === dbId) return _client;
  _client = new Firestore({ ...opts, databaseId: dbId });
  _databaseId = dbId;
  return _client;
}

/**
 * Set the cached client. Useful for tests that want to inject a fake.
 */
export function setFirestore(client: Firestore, databaseId = '(default)'): void {
  _client = client;
  _databaseId = databaseId;
}

export interface CollectionPath {
  database: string;     // Firestore database id
  collection: string;   // collection name (e.g. 'mappings', 'lean_view', 'clicks')
}

/**
 * Get a document by its natural-keyed path. Returns null if missing.
 * Note: `path.database` is informational only — the actual database
 * is set at client construction time. Mismatches throw.
 */
export async function getDoc<T = unknown>(
  path: CollectionPath,
  docId: string,
): Promise<T | null> {
  assertDatabaseMatch(path.database);
  const db = getFirestore();
  const snap = await db.doc(`${path.collection}/${docId}`).get();
  if (!snap.exists) return null;
  return snap.data() as T;
}

/**
 * Upsert a document. `merge: true` so retries don't clobber fields
 * the listener has not produced yet.
 */
export async function upsertDoc<T extends Record<string, unknown>>(
  path: CollectionPath,
  docId: string,
  data: T,
): Promise<void> {
  assertDatabaseMatch(path.database);
  const db = getFirestore();
  await db.doc(`${path.collection}/${docId}`).set(data, { merge: true });
}

/**
 * Increment a numeric field atomically.
 * Used by the analytics click aggregator.
 */
export async function incrementField(
  path: CollectionPath,
  docId: string,
  field: string,
  by = 1,
): Promise<void> {
  assertDatabaseMatch(path.database);
  const db = getFirestore();
  await db.doc(`${path.collection}/${docId}`).update({
    [field]: FieldValue.increment(by),
  });
}

function assertDatabaseMatch(expected: string) {
  if (_databaseId !== expected) {
    throw new Error(
      `firestore client is bound to '${_databaseId}' but call expected '${expected}'. ` +
      `Call getFirestore({ databaseId: '${expected}' }) at startup.`
    );
  }
}
