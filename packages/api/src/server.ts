import { serve } from "@hono/node-server";
import { createApp, globalQueue, globalSessionStore } from "./app.js";
import { initOtel } from "./otel.js";
import { globalAuthStore } from "./auth-store.js";
import { globalConnectorsStore } from "./connectors-store.js";
import { startInlineWorkerLoop } from "./worker-loop.js";

const port = Number(process.env.PORT ?? process.env.STEW_API_PORT ?? 8081);
await initOtel("stew-api");
const app = createApp();

await globalQueue.load();
await globalSessionStore.load();
await globalAuthStore.load();
await globalConnectorsStore.load();

// Org UI runtime knobs (env always wins when set)
try {
  const { applyOrgRuntimeToProcess } = await import("./runtime-config.js");
  await applyOrgRuntimeToProcess(process.env.STEW_DEFAULT_ORG_ID ?? "local");
} catch (err) {
  console.warn("[api] runtime config apply failed", err);
}

console.log(`stew-api listening on :${port}`);
serve({ fetch: app.fetch, port });

// Default ON for self-host: process jobs without a separate worker process.
// Set STEW_INLINE_WORKER=0 when running pnpm dev:worker / production workers.
startInlineWorkerLoop();
