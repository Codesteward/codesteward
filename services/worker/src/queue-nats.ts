import type { ReviewJob } from "@codesteward/core";

/**
 * Optional NATS JetStream consumer.
 * When NATS_URL is set, attempts to connect with the `nats` package.
 *
 * Install: `pnpm add nats --filter @codesteward/worker`
 * Streams: reviews.gate / reviews.steward (or STEW_NATS_SUBJECT)
 *
 * If the nats package is missing or connect fails, returns a no-op consumer
 * so the worker falls back to the file/Postgres queue.
 */
export async function createNatsConsumer(
  natsUrl: string,
): Promise<{
  dequeue: () => Promise<ReviewJob | undefined>;
  close: () => Promise<void>;
  /** True when a live NATS connection is active */
  connected: boolean;
}> {
  const subject =
    process.env.STEW_NATS_SUBJECT ??
    process.env.NATS_SUBJECT ??
    "reviews.>";
  const durable =
    process.env.STEW_NATS_DURABLE ?? "stew-worker";
  const stream = process.env.STEW_NATS_STREAM ?? "REVIEWS";

  try {
    // Dynamic import so builds succeed without nats installed
    const natsMod = await import("nats");
    const nc = await natsMod.connect({ servers: natsUrl });
    const js = nc.jetstream();

    // Ensure consumer (best-effort; stream may be pre-created)
    try {
      const jsm = await nc.jetstreamManager();
      try {
        await jsm.streams.info(stream);
      } catch {
        await jsm.streams.add({
          name: stream,
          subjects: ["reviews.>"],
        });
      }
      try {
        await jsm.consumers.info(stream, durable);
      } catch {
        await jsm.consumers.add(stream, {
          durable_name: durable,
          ack_policy: natsMod.AckPolicy.Explicit,
          filter_subject: subject.includes(">") ? undefined : subject,
        });
      }
    } catch (err) {
      console.warn(
        "[worker] NATS stream/consumer setup warning:",
        err instanceof Error ? err.message : err,
      );
    }

    const consumer = await js.consumers.get(stream, durable);
    console.info(
      `[worker] NATS connected url=${natsUrl} stream=${stream} durable=${durable}`,
    );

    return {
      connected: true,
      async dequeue() {
        try {
          const messages = await consumer.fetch({ max_messages: 1, expires: 1000 });
          for await (const m of messages) {
            try {
              const text = new TextDecoder().decode(m.data);
              const job = JSON.parse(text) as ReviewJob;
              m.ack();
              return job;
            } catch (err) {
              console.warn(
                "[worker] NATS message parse failed, nak:",
                err instanceof Error ? err.message : err,
              );
              m.nak();
            }
          }
        } catch {
          /* timeout / empty */
        }
        return undefined;
      },
      async close() {
        await nc.drain().catch(() => undefined);
        await nc.close().catch(() => undefined);
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[worker] NATS_URL=${natsUrl} set but NATS client unavailable (${msg}). ` +
        `Install the 'nats' package (pnpm add nats --filter @codesteward/worker) and ensure JetStream is running. ` +
        `Falling back to file/Postgres queue.`,
    );
    return {
      connected: false,
      async dequeue() {
        return undefined;
      },
      async close() {},
    };
  }
}
