// libs/proto-decode — decode Firestore Eventarc `DocumentEventData`.
//
// Eventarc → Cloud Run delivers CloudEvents in binary mode:
//   - ce-* metadata in HTTP headers
//   - body = application/protobuf DocumentEventData
//
// We decode with protobufjs + an inline schema matching
// google.events.cloud.firestore.v1.DocumentEventData /
// google.firestore.v1.Document + Value.

import protobuf from 'protobufjs';

/**
 * Minimal schema sufficient to extract string fields from a mapping doc.
 * Field numbers match google.firestore.v1.Value (string_value = 17).
 */
const root = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: { type: 'int64', id: 1 },
                nanos: { type: 'int32', id: 2 },
              },
            },
          },
        },
        firestore: {
          nested: {
            v1: {
              nested: {
                Value: {
                  oneofs: {
                    valueType: {
                      oneof: [
                        'nullValue',
                        'booleanValue',
                        'integerValue',
                        'doubleValue',
                        'timestampValue',
                        'stringValue',
                        'bytesValue',
                        'referenceValue',
                      ],
                    },
                  },
                  fields: {
                    nullValue: { type: 'int32', id: 1 },
                    booleanValue: { type: 'bool', id: 2 },
                    integerValue: { type: 'int64', id: 3 },
                    doubleValue: { type: 'double', id: 4 },
                    timestampValue: { type: 'google.protobuf.Timestamp', id: 10 },
                    stringValue: { type: 'string', id: 17 },
                    bytesValue: { type: 'bytes', id: 18 },
                    referenceValue: { type: 'string', id: 21 },
                  },
                },
                Document: {
                  fields: {
                    name: { type: 'string', id: 1 },
                    // map<string, Value> — protobufjs IField typings omit keyType
                    fields: { type: 'Value', id: 2, keyType: 'string' } as protobuf.IField,
                    createTime: { type: 'google.protobuf.Timestamp', id: 3 },
                    updateTime: { type: 'google.protobuf.Timestamp', id: 4 },
                  },
                },
              },
            },
          },
        },
        events: {
          nested: {
            cloud: {
              nested: {
                firestore: {
                  nested: {
                    v1: {
                      nested: {
                        DocumentEventData: {
                          fields: {
                            value: { type: 'google.firestore.v1.Document', id: 1 },
                            oldValue: { type: 'google.firestore.v1.Document', id: 2 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const DocumentEventDataType = root.lookupType(
  'google.events.cloud.firestore.v1.DocumentEventData',
);

export interface DecodedFirestoreDocument {
  name: string;
  fields: Record<string, { stringValue?: string; timestampValue?: string }>;
  createTime?: string;
}

export interface DecodedDocumentEvent {
  path: string;
  document: DecodedFirestoreDocument;
}

function timestampToIso(ts: { seconds?: string | number | { toNumber?: () => number }; nanos?: number } | null | undefined): string | undefined {
  if (!ts || ts.seconds == null) return undefined;
  const raw = ts.seconds;
  const seconds = typeof raw === 'object' && raw && typeof raw.toNumber === 'function'
    ? raw.toNumber()
    : Number(raw);
  const millis = seconds * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
  return new Date(millis).toISOString();
}

/**
 * Extract the document path (collection/id) from the document name.
 * Example: "projects/p/databases/app-db/documents/mappings/abc" -> "mappings/abc"
 */
export function docPathFromName(name: string): string {
  const idx = name.lastIndexOf('documents/');
  if (idx < 0) throw new Error(`Cannot extract document path from name: ${name}`);
  return name.slice(idx + 'documents/'.length);
}

/**
 * Decode a raw Firestore Eventarc protobuf body (DocumentEventData).
 */
export function decodeDocumentEventDataBytes(buf: Uint8Array): DecodedDocumentEvent {
  const decoded = DocumentEventDataType.decode(buf) as protobuf.Message & {
    value?: {
      name?: string;
      fields?: Record<string, {
        stringValue?: string;
        timestampValue?: { seconds?: string | number; nanos?: number };
      }>;
      createTime?: { seconds?: string | number; nanos?: number };
    };
  };
  const value = decoded.value;
  if (!value?.name) {
    throw new Error('DocumentEventData has no value.name');
  }

  const fields: DecodedFirestoreDocument['fields'] = {};
  for (const [key, v] of Object.entries(value.fields ?? {})) {
    fields[key] = {
      stringValue: v.stringValue,
      timestampValue: timestampToIso(v.timestampValue),
    };
  }

  const document: DecodedFirestoreDocument = {
    name: value.name,
    fields,
    createTime: timestampToIso(value.createTime),
  };

  return { path: docPathFromName(value.name), document };
}
