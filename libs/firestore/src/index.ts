// libs/firestore — Firestore client factory + small collection helpers.
//
// One client per process. We never instantiate per-request.
//
// BFF ownership: each BFF points at its own database (e.g. `app-db`,
// `redirect-db`, `analytics-db`). This file only provides the client
// and a thin `getDoc/setDoc` wrapper that uses the document path as
// the natural idempotency key for at-least-once delivery.

import { Firestore, FieldValue, type Settings } from '@google-cloud/firestore';

let _client: Firestore | null = null;

/**
 * Get or create the Firestore client.
 * In Cloud Run the runtime SA has roles/datastore.user on the
 * project's databases; no explicit credentials are needed in code.
 */
export function getFirestore(opts?: Settings): Firestore {
  if (_client) return _client;
  _client = new Firestore(opts);
  return _client;
}

/**
 * Set the cached client. Useful for tests that want to inject a fake.
 */
export function setFirestore(client: Firestore): void {
  _client = client;
}

export interface CollectionPath {
  database: string;     // Firestore database id
  collection: string;   // collection name (e.g. 'mappings', 'lean_view', 'clicks')
}

/**
 * Get a document by its natural-keyed path. Returns null if missing.
 */
export async function getDoc<T = unknown>(
  path: CollectionPath,
  docId: string,
): Promise<T | null> {
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
  const db = getFirestore();
  await db.doc(`${path.collection}/${docId}`).update({
    [field]: FieldValue.increment(by),
  });
}
