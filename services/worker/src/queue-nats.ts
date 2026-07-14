/**
 * @deprecated Prefer STEW_QUEUE_BROKER=nats (hybrid JobQueue in @codesteward/api).
 * Compatibility wrapper around createJobBroker.
 */
import { createJobBroker } from "@codesteward/api";
import type { ReviewJob } from "@codesteward/core";

export async function createNatsConsumer(natsUrl: string): Promise<{
  dequeue: () => Promise<ReviewJob | undefined>;
  close: () => Promise<void>;
  connected: boolean;
}> {
  process.env.NATS_URL = process.env.NATS_URL ?? natsUrl;
  process.env.STEW_QUEUE_BROKER = process.env.STEW_QUEUE_BROKER ?? "nats";
  const broker = await createJobBroker();
  if (!broker) {
    return {
      connected: false,
      dequeue: async () => undefined,
      close: async () => undefined,
    };
  }
  return {
    connected: true,
    dequeue: async () => {
      const msg = await broker.consume(1000);
      if (!msg) return undefined;
      await msg.ack();
      return msg.job;
    },
    close: () => broker.close(),
  };
}
