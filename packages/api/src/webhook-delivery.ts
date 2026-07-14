/**
 * Persist-before-process delivery log for SCM webhooks (idempotency).
 * Prefers Postgres scm_delivery_log via JobsRepository.tryRecordDelivery;
 * falls back to file store. markProcessed completes the lifecycle.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function claimDelivery(input: {
  provider: string;
  deliveryId: string;
  event?: string;
  orgId?: string;
  repoId?: string;
  rawBody?: string;
}): Promise<{ accepted: boolean; duplicate: boolean; deliveryId: string }> {
  const id =
    input.deliveryId ||
    createHash("sha256")
      .update(`${input.provider}:${Date.now()}:${input.rawBody?.slice(0, 64) ?? ""}`)
      .digest("hex")
      .slice(0, 24);

  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.jobs) {
        const payloadHash = createHash("sha256")
          .update(input.rawBody ?? id)
          .digest("hex")
          .slice(0, 32);
        const result = await db.jobs.tryRecordDelivery({
          deliveryId: id,
          provider: input.provider,
          eventType: input.event ?? "unknown",
          orgId: input.orgId ?? "local",
          repoId: input.repoId ?? "unknown",
          payloadHash,
          status: "received",
        });
        if (!result.isNew) {
          return { accepted: false, duplicate: true, deliveryId: id };
        }
        return { accepted: true, duplicate: false, deliveryId: id };
      }
    }
  } catch (err) {
    console.warn("[webhook-delivery] postgres path failed, file fallback", err);
  }

  const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
  const file = join(dir, "webhook_deliveries.json");
  await mkdir(dir, { recursive: true });
  let rows: Array<{
    id: string;
    provider: string;
    event?: string;
    at: string;
    status?: string;
  }> = [];
  try {
    rows = JSON.parse(await readFile(file, "utf8")) as typeof rows;
  } catch {
    rows = [];
  }
  if (rows.some((r) => r.id === id && r.provider === input.provider)) {
    return { accepted: false, duplicate: true, deliveryId: id };
  }
  rows.push({
    id,
    provider: input.provider,
    event: input.event,
    at: new Date().toISOString(),
    status: "received",
  });
  if (rows.length > 5000) rows = rows.slice(-5000);
  await writeFile(file, JSON.stringify(rows, null, 2), "utf8");
  return { accepted: true, duplicate: false, deliveryId: id };
}

export async function markDeliveryProcessed(
  deliveryId: string,
  opts?: { status?: "processed" | "failed"; error?: string; sessionId?: string; jobId?: string },
): Promise<void> {
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.jobs) {
        await db.jobs.markDeliveryProcessed(deliveryId, {
          status: opts?.status ?? "processed",
          error: opts?.error,
          sessionId: opts?.sessionId,
          jobId: opts?.jobId,
        });
        return;
      }
    }
  } catch (err) {
    console.warn("[webhook-delivery] markProcessed postgres failed", err);
  }
  const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
  const file = join(dir, "webhook_deliveries.json");
  try {
    const rows = JSON.parse(await readFile(file, "utf8")) as Array<{
      id: string;
      status?: string;
      error?: string;
    }>;
    for (const r of rows) {
      if (r.id === deliveryId) {
        r.status = opts?.status ?? "processed";
        if (opts?.error) r.error = opts.error;
      }
    }
    await writeFile(file, JSON.stringify(rows, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}
