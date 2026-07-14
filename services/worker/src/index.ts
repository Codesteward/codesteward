import {
  globalQueue,
  globalSessionStore,
  runReviewJob,
  resumeIncompleteSessions,
} from "@codesteward/api";

const pollMs = Number(process.env.STEW_WORKER_POLL_MS ?? 1500);

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
      "otel.backend": "console",
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

  const queueDesc = globalQueue.describe?.() ?? "unknown";
  console.log("[worker] starting Codesteward review worker");
  console.log(
    `[worker] queue=${queueDesc} GRAPH_MOCK=${process.env.GRAPH_MOCK ?? "0"} DEEPAGENTS=${process.env.STEW_USE_DEEPAGENTS ?? "auto"} SANDBOX=${process.env.STEW_SANDBOX_PROVIDER ?? "null"}`,
  );

  await resumeIncompleteSessions({
    label: "worker",
    log: (msg, ...args) => console.log(`[worker] ${msg}`, ...args),
  });

  for (;;) {
    try {
      await globalSessionStore.reload();
      await globalQueue.load();
      const job = await globalQueue.dequeue();
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
