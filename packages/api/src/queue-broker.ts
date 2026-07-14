/**
 * Optional message brokers for review job dispatch (KEDA-friendly).
 * Postgres (or file) remains the durable job SoT; brokers only wake workers.
 *
 * Enable with STEW_QUEUE_BROKER=nats|rabbitmq|pulsar and the matching URL env.
 * Clients are optionalDependencies / dynamic imports — missing packages log and disable.
 */
import type { ReviewJob } from "@codesteward/core";

export type BrokerKind = "nats" | "rabbitmq" | "pulsar";

export interface ConsumedJob {
  job: ReviewJob;
  /** Call after successful processing (or after PG owns retry). */
  ack: () => Promise<void>;
  /** Prefer ack + PG fail for retries; nack redelivers from broker. */
  nack: () => Promise<void>;
}

export interface JobBroker {
  readonly kind: BrokerKind;
  publish(job: ReviewJob): Promise<void>;
  /** Wait up to timeoutMs for one message; undefined = empty. */
  consume(timeoutMs?: number): Promise<ConsumedJob | undefined>;
  /** Approximate ready depth (best-effort; for logging / future metrics). */
  depth?(): Promise<number | undefined>;
  close(): Promise<void>;
}

export function resolveBrokerKind(
  env: NodeJS.ProcessEnv = process.env,
): BrokerKind | null {
  const explicit = (env.STEW_QUEUE_BROKER ?? env.QUEUE_BROKER ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "nats" || explicit === "rabbitmq" || explicit === "rabbit" || explicit === "pulsar") {
    return explicit === "rabbit" ? "rabbitmq" : (explicit as BrokerKind);
  }
  // Infer from URL envs when STEW_QUEUE_BROKER unset
  if (env.NATS_URL?.trim()) return "nats";
  if (env.RABBITMQ_URL?.trim() || env.AMQP_URL?.trim()) return "rabbitmq";
  if (env.PULSAR_URL?.trim()) return "pulsar";
  return null;
}

export async function createJobBroker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobBroker | null> {
  const kind = resolveBrokerKind(env);
  if (!kind) return null;
  try {
    if (kind === "nats") return await createNatsBroker(env);
    if (kind === "rabbitmq") return await createRabbitBroker(env);
    if (kind === "pulsar") return await createPulsarBroker(env);
  } catch (err) {
    console.warn(
      `[queue-broker] failed to init ${kind}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

// ── NATS JetStream ───────────────────────────────────────────────

async function createNatsBroker(env: NodeJS.ProcessEnv): Promise<JobBroker> {
  const natsUrl = env.NATS_URL?.trim();
  if (!natsUrl) throw new Error("NATS_URL required for STEW_QUEUE_BROKER=nats");

  // optionalDependency — load without static module resolution
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const natsMod = (await new Function("return import('nats')")()) as {
    connect: (opts: { servers: string }) => Promise<{
      jetstream: () => {
        publish: (subj: string, data: Uint8Array, opts?: { msgID?: string }) => Promise<unknown>;
        consumers: { get: (stream: string, durable: string) => Promise<{
          fetch: (opts: { max_messages: number; expires: number }) => AsyncIterable<{
            data: Uint8Array;
            ack: () => void;
            nak: () => void;
          }>;
        }> };
      };
      jetstreamManager: () => Promise<{
        streams: { info: (n: string) => Promise<unknown>; add: (cfg: unknown) => Promise<unknown> };
        consumers: {
          info: (s: string, d: string) => Promise<{ num_pending?: number }>;
          add: (s: string, cfg: unknown) => Promise<unknown>;
        };
      }>;
      drain: () => Promise<void>;
      close: () => Promise<void>;
    }>;
    AckPolicy: { Explicit: unknown };
  };
  const subject = env.STEW_NATS_SUBJECT ?? env.NATS_SUBJECT ?? "reviews.jobs";
  const stream = env.STEW_NATS_STREAM ?? "REVIEWS";
  const durable = env.STEW_NATS_DURABLE ?? "stew-worker";

  const nc = await natsMod.connect({ servers: natsUrl });
  const js = nc.jetstream();
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
      // Long reviews: allow progress; worker still uses PG lease for ownership
      ack_wait: 60 * 60 * 1_000_000_000, // 60m in ns
    });
  }

  const consumer = await js.consumers.get(stream, durable);
  console.info(
    `[queue-broker] NATS ready url=${natsUrl} stream=${stream} subject=${subject} durable=${durable}`,
  );

  return {
    kind: "nats",
    async publish(job) {
      const data = new TextEncoder().encode(JSON.stringify(job));
      await js.publish(subject, data, { msgID: job.id });
    },
    async consume(timeoutMs = 1000) {
      try {
        const messages = await consumer.fetch({
          max_messages: 1,
          expires: Math.max(250, timeoutMs),
        });
        for await (const m of messages) {
          try {
            const job = JSON.parse(new TextDecoder().decode(m.data)) as ReviewJob;
            return {
              job,
              ack: async () => {
                m.ack();
              },
              nack: async () => {
                m.nak();
              },
            };
          } catch {
            m.nak();
          }
        }
      } catch {
        /* empty / timeout */
      }
      return undefined;
    },
    async depth() {
      try {
        const info = await jsm.consumers.info(stream, durable);
        const n = info.num_pending;
        return typeof n === "number" ? n : undefined;
      } catch {
        return undefined;
      }
    },
    async close() {
      await nc.drain().catch(() => undefined);
      await nc.close().catch(() => undefined);
    },
  };
}

// ── RabbitMQ ─────────────────────────────────────────────────────

async function createRabbitBroker(env: NodeJS.ProcessEnv): Promise<JobBroker> {
  const url = (env.RABBITMQ_URL ?? env.AMQP_URL ?? "").trim();
  if (!url) throw new Error("RABBITMQ_URL (or AMQP_URL) required for rabbitmq broker");

  // optionalDependency
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func, @typescript-eslint/no-explicit-any
  const amqp = (await new Function("return import('amqplib')")()) as any;
  const connect = amqp.connect ?? amqp.default?.connect;
  if (!connect) throw new Error("amqplib.connect not found — pnpm add amqplib");

  const queue = env.STEW_RABBITMQ_QUEUE ?? env.RABBITMQ_QUEUE ?? "codesteward.reviews";
  const conn = await connect(url);
  const ch = await conn.createChannel();
  await ch.assertQueue(queue, { durable: true });
  await ch.prefetch(1);
  console.info(`[queue-broker] RabbitMQ ready queue=${queue}`);

  return {
    kind: "rabbitmq",
    async publish(job) {
      const body = Buffer.from(JSON.stringify(job), "utf8");
      const ok = ch.sendToQueue(queue, body, {
        persistent: true,
        contentType: "application/json",
        messageId: job.id,
      });
      if (!ok) {
        await new Promise<void>((resolve) => ch.once("drain", () => resolve()));
      }
    },
    async consume(timeoutMs = 1000) {
      return await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        }, Math.max(250, timeoutMs));

        void ch
          .get(queue, { noAck: false })
          .then((msg: { content: Buffer; fields: unknown } | false) => {
            if (settled) {
              if (msg) ch.nack(msg, false, true);
              return;
            }
            settled = true;
            clearTimeout(timer);
            if (!msg) {
              resolve(undefined);
              return;
            }
            try {
              const job = JSON.parse(msg.content.toString("utf8")) as ReviewJob;
              resolve({
                job,
                ack: async () => {
                  ch.ack(msg);
                },
                nack: async () => {
                  ch.nack(msg, false, true);
                },
              });
            } catch {
              ch.nack(msg, false, false);
              resolve(undefined);
            }
          })
          .catch(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(undefined);
            }
          });
      });
    },
    async depth() {
      try {
        const q = await ch.checkQueue(queue);
        return typeof q?.messageCount === "number" ? q.messageCount : undefined;
      } catch {
        return undefined;
      }
    },
    async close() {
      await ch.close().catch(() => undefined);
      await conn.close().catch(() => undefined);
    },
  };
}

// ── Apache Pulsar ────────────────────────────────────────────────

async function createPulsarBroker(env: NodeJS.ProcessEnv): Promise<JobBroker> {
  const serviceUrl = env.PULSAR_URL?.trim();
  if (!serviceUrl) throw new Error("PULSAR_URL required for STEW_QUEUE_BROKER=pulsar");

  const topic =
    env.STEW_PULSAR_TOPIC ??
    env.PULSAR_TOPIC ??
    "persistent://public/default/codesteward-reviews";
  const subscription =
    env.STEW_PULSAR_SUBSCRIPTION ?? env.PULSAR_SUBSCRIPTION ?? "stew-worker";

  // Native addon — optionalDependency; may be unavailable on some platforms
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func, @typescript-eslint/no-explicit-any
  const Pulsar = (await new Function("return import('pulsar-client')")()) as any;
  const Client = Pulsar.Client ?? Pulsar.default?.Client ?? Pulsar.default;
  if (!Client) throw new Error("pulsar-client not available — pnpm add pulsar-client");

  const client = new Client({ serviceUrl });
  const producer = await client.createProducer({ topic });
  const consumer = await client.subscribe({
    topic,
    subscription,
    subscriptionType: "Shared",
    ackTimeoutMs: 3_600_000,
  });
  console.info(
    `[queue-broker] Pulsar ready url=${serviceUrl} topic=${topic} sub=${subscription}`,
  );

  return {
    kind: "pulsar",
    async publish(job) {
      await producer.send({
        data: Buffer.from(JSON.stringify(job), "utf8"),
        properties: { jobId: job.id },
      });
    },
    async consume(timeoutMs = 1000) {
      try {
        const msg = await consumer.receive(Math.max(250, timeoutMs));
        try {
          const job = JSON.parse(msg.getData().toString("utf8")) as ReviewJob;
          return {
            job,
            ack: async () => {
              await consumer.acknowledge(msg);
            },
            nack: async () => {
              await consumer.negativeAcknowledge(msg);
            },
          };
        } catch {
          await consumer.negativeAcknowledge(msg);
          return undefined;
        }
      } catch {
        return undefined;
      }
    },
    async close() {
      await producer.close().catch(() => undefined);
      await consumer.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}
