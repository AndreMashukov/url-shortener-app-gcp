// libs/pubsub — minimal publish + subscribe helpers around @google-cloud/pubsub.
//
// Used by:
//   - app-bff: NEVER publishes (per BRAINSTORM §1 sole-producer rule).
//   - redirect-bff: publishes `click.recorded` from the HTTP handler.
//   - Eventarc Firestore trigger: publishes `mapping.created`.
//
// The trigger runs as a dedicated Cloud Run service; its publish code
// uses this lib. Pub/Sub publish is fire-and-forget with a Promise.all
// for batching.

import { PubSub } from '@google-cloud/pubsub';
import type { MessageOptions } from '@google-cloud/pubsub/build/src/topic';

let _client: PubSub | null = null;

export function getPubSub(): PubSub {
  if (_client) return _client;
  _client = new PubSub();
  return _client;
}

/**
 * Publish a CloudEvent-shaped JSON message to a topic.
 * `eventId` becomes the Pub/Sub messageId-equivalent (we set it as
 * an attribute so listeners can dedupe on it).
 */
export async function publishEvent(opts: {
  topicName: string;
  eventId: string;
  type: string;
  data: unknown;
}): Promise<string> {
  const pubsub = getPubSub();
  const topic = pubsub.topic(opts.topicName);
  const message: MessageOptions = {
    json: { id: opts.eventId, type: opts.type, data: opts.data },
    attributes: { eventId: opts.eventId, type: opts.type },
  };
  const messageId = await topic.publishMessage(message);
  return messageId;
}

/**
 * Subscribe to a topic and dispatch messages to `handler`. Returns a
 * function to close the subscription. Used by the redirect-bff /
 * analytics-bff Eventarc Pub/Sub push receivers.
 */
export function subscribeToEvents(opts: {
  subscriptionName: string;
  handler: (msg: { eventId: string; type: string; data: unknown }) => Promise<void>;
  onError?: (err: Error) => void;
}): () => Promise<void> {
  const pubsub = getPubSub();
  const sub = pubsub.subscription(opts.subscriptionName);
  const messageHandler = async (message: { attributes: Record<string, string>; ack: () => void; nack: () => void; data: Buffer }) => {
    try {
      const eventId = message.attributes['eventId'] ?? 'unknown';
      const type    = message.attributes['type']    ?? 'unknown';
      const data    = JSON.parse(message.data.toString());
      await opts.handler({ eventId, type, data });
      message.ack();
    } catch (err) {
      opts.onError?.(err as Error);
      message.nack();
    }
  };
  sub.on('message', messageHandler as never);
  return async () => {
    sub.off('message', messageHandler as never);
    await sub.close();
  };
}
