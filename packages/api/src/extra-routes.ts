import type { Hono } from "hono";
import type { FindingsStore } from "@codesteward/findings";
import type { ReviewSession } from "@codesteward/core";
import type { JobQueue } from "./queue.js";

type SessionStore = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (req: any) => ReviewSession;
  get: (id: string) => ReviewSession | undefined;
  list: () => ReviewSession[];
};

export function registerExtraRoutes(
  app: Hono,
  deps: {
    findingsStore: FindingsStore;
    globalSessionStore: SessionStore;
    globalQueue: JobQueue;
  },
) {
  const { findingsStore, globalSessionStore, globalQueue } = deps;

  app.get("/v1/org/analytics/address-rate", async (c) => {
    const orgId = (c.get("orgId") as string | undefined) ?? "local";
    const list = await findingsStore.list({ orgId });
    const total = list.length;
    const addressed = list.filter((f) =>
      ["fixed", "dismissed", "wontfix", "false_positive"].includes(f.status),
    ).length;
    const bySeverity: Record<string, { total: number; addressed: number }> = {};
    for (const f of list) {
      const b = (bySeverity[f.severity] ??= { total: 0, addressed: 0 });
      b.total += 1;
      if (["fixed", "dismissed", "wontfix", "false_positive"].includes(f.status)) b.addressed += 1;
    }
    const rate = total === 0 ? null : Math.round((addressed / total) * 1000) / 10;
    return c.json({ orgId, total, addressed, addressRate: rate, bySeverity });
  });

  app.post("/v1/reviews/ask", async (c) => {
    const body = (await c.req.json()) as {
      question?: string;
      sessionId?: string;
      context?: string;
    };
    if (!body.question?.trim()) return c.json({ error: "question required" }, 400);
    const orgId = (c.get("orgId") as string | undefined) ?? "local";
    const authMode = c.get("authMode") as string | undefined;
    const { createModelRouter } = await import("@codesteward/model-router");
    const router = createModelRouter();
    const model = router.createChatModel("default");
    let sessionCtx = "";
    if (body.sessionId) {
      const s = globalSessionStore.get(body.sessionId);
      if (!s) return c.json({ error: "session not found" }, 404);
      if ((s.orgId ?? "local") !== orgId && authMode !== "dev_open") {
        return c.json({ error: "forbidden", message: "session not in active org" }, 403);
      }
      sessionCtx = `Session ${s.id} mode=${s.mode} status=${s.status} stage=${s.stage} repo=${s.repoId}`;
      const findings = await findingsStore.list({ sessionId: body.sessionId, orgId });
      sessionCtx +=
        "\nFindings:\n" +
        findings
          .slice(0, 20)
          .map((f) => `- [${f.severity}] ${f.title} (${f.path})`)
          .join("\n");
    }
    const res = await model.complete({
      system:
        "You are CodeSteward conversation agent. Answer about the review context. Be concise and actionable.",
      messages: [
        {
          role: "user",
          content: `${sessionCtx}\n\n${body.context ?? ""}\n\nQuestion: ${body.question}`,
        },
      ],
      maxTokens: 800,
    });
    return c.json({ answer: res.content, model: res.model, provider: res.provider });
  });

  for (const provider of ["bitbucket", "gitea", "azure-devops"] as const) {
    app.post(`/v1/webhooks/${provider}`, async (c) => {
      const raw = await c.req.text();
      const strict =
        process.env.STEW_AUTH_STRICT === "1" || process.env.NODE_ENV === "production";
      // Signature / token verification (P0 multi-SCM)
      if (provider === "bitbucket") {
        const secret = process.env.BITBUCKET_WEBHOOK_SECRET;
        const sig =
          c.req.header("x-hub-signature") ??
          c.req.header("X-Hub-Signature") ??
          c.req.header("x-hub-signature-256");
        if (strict && !secret) {
          return c.json({ error: "BITBUCKET_WEBHOOK_SECRET required" }, 500);
        }
        if (secret && secret !== "dev-insecure") {
          const { createHmac, timingSafeEqual } = await import("node:crypto");
          const expected =
            "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
          const a = Buffer.from(expected);
          const b = Buffer.from(sig ?? "");
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return c.json({ error: "invalid signature" }, 401);
          }
        }
      }
      if (provider === "gitea") {
        const secret = process.env.GITEA_WEBHOOK_SECRET;
        const sig = c.req.header("x-gitea-signature") ?? c.req.header("X-Gitea-Signature");
        if (strict && !secret) {
          return c.json({ error: "GITEA_WEBHOOK_SECRET required" }, 500);
        }
        if (secret && secret !== "dev-insecure" && sig) {
          const { createHmac, timingSafeEqual } = await import("node:crypto");
          const expected = createHmac("sha256", secret).update(raw).digest("hex");
          const a = Buffer.from(expected);
          const b = Buffer.from(sig);
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return c.json({ error: "invalid signature" }, 401);
          }
        } else if (secret && secret !== "dev-insecure" && !sig && strict) {
          return c.json({ error: "missing signature" }, 401);
        }
      }
      if (provider === "azure-devops") {
        const secret = process.env.AZURE_DEVOPS_WEBHOOK_SECRET;
        // ADO basic user:pass in header or shared secret query — accept bearer match
        if (strict && !secret) {
          return c.json({ error: "AZURE_DEVOPS_WEBHOOK_SECRET required" }, 500);
        }
        if (secret && secret !== "dev-insecure") {
          const auth = c.req.header("authorization") ?? "";
          if (!auth.includes(secret) && c.req.query("secret") !== secret) {
            return c.json({ error: "invalid webhook credential" }, 401);
          }
        }
      }
      let multiDeliveryId =
        c.req.header("x-request-id") ??
        c.req.header("x-hook-uuid") ??
        c.req.header("x-gitea-delivery") ??
        (await import("node:crypto")).createHash("sha256").update(raw).digest("hex").slice(0, 24);
      {
        const { claimDelivery } = await import("./webhook-delivery.js");
        const claim = await claimDelivery({
          provider,
          deliveryId: String(multiDeliveryId),
          event: c.req.header("x-event-key") ?? c.req.header("x-gitea-event") ?? "push",
          rawBody: raw,
        });
        multiDeliveryId = claim.deliveryId;
        if (claim.duplicate) {
          return c.json({ ok: true, duplicate: true, provider }, 200);
        }
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
      // Minimal accept + enqueue for multi-SCM webhook surface
      const pr = (payload.pullrequest ??
        payload.pull_request ??
        (payload.resource as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>;
      const prNumber = Number(
        pr.id ?? pr.number ?? pr.pullRequestId ?? 0,
      );
      if (!prNumber) return c.json({ ignored: true, provider });
      const repoObj = (payload.repository ?? pr.repository ?? {}) as Record<string, unknown>;
      const fullName = String(
        repoObj.full_name ??
          `${(repoObj.project as { name?: string } | undefined)?.name ?? "org"}/${repoObj.name ?? "repo"}`,
      );
      const [owner, repo] = fullName.split("/");
      const session = globalSessionStore.create({
        mode: "gate",
        repoId: fullName,
        orgId: owner,
        prNumber,
        scmProvider: provider,
        scmFullName: fullName,
        trigger: "webhook",
        paths: ["."],
        riskTier: "full",
      });
      const job = await globalQueue.enqueue({
        sessionId: session.id,
        mode: "gate",
        tenantId: session.tenantId,
        repoId: session.repoId,
        repoPath: process.env.REPO_PATH ?? process.cwd(),
        prNumber,
        paths: ["."],
        riskTier: "full",
        depth: "normal",
        scm: {
          provider: provider === "azure-devops" ? "azure-devops" : provider,
          owner: owner ?? "org",
          repo: repo ?? "repo",
          prNumber,
          publish: true,
        },
      });
      const { markDeliveryProcessed } = await import("./webhook-delivery.js");
      await markDeliveryProcessed(String(multiDeliveryId), {
        status: "processed",
        sessionId: session.id,
        jobId: job.id,
      }).catch(() => undefined);
      return c.json({ accepted: true, provider, sessionId: session.id, jobId: job.id }, 202);
    });
  }
}
