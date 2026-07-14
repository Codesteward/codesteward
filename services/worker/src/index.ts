import {
  globalQueue,
  globalSessionStore,
  runReviewJob,
  resumeIncompleteSessions,
} from "@codesteward/api";
import type { ReviewJob } from "@codesteward/core";
import { createNatsConsumer } from "./queue-nats.js";

const pollMs = Number(process.env.STEW_WORKER_POLL_MS ?? 1500);
const natsUrl = process.env.NATS_URL;

async function initWorkerOtel() {
  if (process.env.OTEL_ENABLED !== "1") return;
  try {
    await import("@opentelemetry/api");
    console.info("[otel] enabled for stew-worker");
  } catch {
    console.info(
      "[otel] OTEL_ENABLED=1 — console exporter (install @opentelemetry/api for full API)",
    );
  }
  console.info(
    JSON.stringify({
      "resource.service.name": "stew-worker",
      "otel.exporter": "console",
      event: "otel_init",
      ts: new Date().toISOString(),
    }),
  );
}

async function main() {
  await initWorkerOtel();
  await globalQueue.load();
  await globalSessionStore.load();
  try {
    const { applyOrgRuntimeToProcess } = await import("@codesteward/api");
    await applyOrgRuntimeToProcess(process.env.STEW_DEFAULT_ORG_ID ?? "local");
  } catch (err) {
    console.warn("[worker] runtime config apply failed", err);
  }
  console.log("[worker] starting Codesteward review worker");
  console.log(
    `[worker] GRAPH_MOCK=${process.env.GRAPH_MOCK ?? "0"} DEEPAGENTS=${process.env.STEW_USE_DEEPAGENTS ?? "auto"} NATS=${natsUrl ?? "off"} SANDBOX=${process.env.STEW_SANDBOX_PROVIDER ?? "null"}`,
  );

  await resumeIncompleteSessions({
    label: "worker",
    log: (msg, ...args) => console.log(`[worker] ${msg}`, ...args),
  });

  let natsDequeue: (() => Promise<ReviewJob | undefined>) | undefined;
  if (natsUrl) {
    const nats = await createNatsConsumer(natsUrl);
    natsDequeue = nats.dequeue;
  }

  for (;;) {
    try {
      await globalSessionStore.reload();
      await globalQueue.load();
      let job = await globalQueue.dequeue();
      if (!job && natsDequeue) job = await natsDequeue();
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      console.log(`[worker] claim job ${job.id} session=${job.sessionId} mode=${job.mode}`);
      await runReviewJob(job, {
        label: "worker",
        log: (msg, ...args) => console.log(`[worker] ${msg}`, ...args),
      });
    } catch (err) {
      console.error("[worker] loop error", err);
      await sleep(pollMs);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
