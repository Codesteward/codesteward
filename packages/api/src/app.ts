import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ProgressEvent } from "@codesteward/core";
import {
  CreateSessionRequestSchema,
  loadEnvSafe,
} from "./helpers.js";
import { globalQueue } from "./queue.js";
import { globalSessionStore } from "./store.js";
import { findingsToSarif } from "@codesteward/findings";
import { createGraphClient } from "@codesteward/graph-client";
import { loadEnvModelConfig } from "@codesteward/model-router";
import { apiAuthMiddleware, resolveCorsOrigin } from "./middleware/auth.js";
import { registerExtraRoutes } from "./extra-routes.js";
import { registerTenancyRoutes } from "./tenancy/routes.js";
import { registerScimRoutes } from "./scim/routes.js";
import { findingsStore, learningStore } from "./shared-stores.js";
import { globalAuthStore } from "./auth-store.js";
import { globalConnectorsStore } from "./connectors-store.js";
import { getInlineWorkerStatus, isInlineWorkerEnabled } from "./worker-loop.js";
import { requireOrgMatch, orgForbidden } from "./org-guard.js";


function withJobDefaults(
  session: {
    id: string;
    tenantId: string;
    orgId?: string;
    repoId: string;
    repoPath?: string;
    riskTier: string;
    depth: string;
    prNumber?: number;
    baseSha?: string;
    headSha?: string;
    baseBranch?: string;
    mode: "gate" | "stewardship";
  },
  paths?: string[],
) {
  const repoPath = session.repoPath ?? process.env.REPO_PATH ?? process.cwd();
  return {
    sessionId: session.id,
    mode: session.mode,
    tenantId: session.tenantId,
    orgId: session.orgId ?? "local",
    repoId: session.repoId,
    repoPath,
    baseSha: session.baseSha,
    headSha: session.headSha,
    baseBranch: session.baseBranch,
    riskTier: session.riskTier as never,
    depth: session.depth as never,
    paths: paths?.length ? paths : ["."],
    prNumber: session.prNumber,
  };
}

export function createApp() {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: resolveCorsOrigin(),
      allowHeaders: ["Content-Type", "Authorization", "X-Org-Id", "X-Requested-With"],
      exposeHeaders: ["X-Request-Id"],
    }),
  );
  app.use("*", apiAuthMiddleware());

  // Hydrate connector tokens into process.env for SCM/webhooks
  void globalConnectorsStore.ensureLoaded();
  void globalAuthStore.ensureLoaded();

  app.get("/healthz", async (c) => {
    const status = await globalAuthStore.getStatus();
    return c.json({
      ok: true,
      service: "stew-api",
      auth: status.mode,
      authRequired: status.authRequired,
    });
  });
  app.get("/v1/healthz", async (c) => {
    const status = await globalAuthStore.getStatus();
    return c.json({ ok: true, auth: status.mode, authRequired: status.authRequired });
  });
  app.get("/v1/readyz", (c) => c.json({ ready: true }));
  app.get("/v1/auth/status", async (c) => {
    const status = await globalAuthStore.getStatus();
    const { getIdentityMode, isKeycloakIdentityMode } = await import("./identity/mode.js");
    return c.json({
      ...status,
      worker: getInlineWorkerStatus(),
      identityMode: getIdentityMode(),
      keycloakIdentity: isKeycloakIdentityMode(),
    });
  });

  app.post("/v1/auth/bootstrap", async (c) => {
    const body = (await c.req.json()) as {
      email?: string;
      password?: string;
      displayName?: string;
      name?: string;
      orgId?: string;
    };
    try {
      const result = await globalAuthStore.bootstrap({
        email: body.email ?? "",
        password: body.password ?? "",
        displayName: body.displayName ?? body.name,
        orgId: body.orgId ?? c.get("orgId"),
      });
      // Bootstrap admin owns local org membership
      try {
        const { getTenancyStore } = await import("./tenancy/orgs.js");
        const tenancy = getTenancyStore();
        await tenancy.ensureDefaults();
        await tenancy.upsertMember({
          orgId: result.user.orgId ?? "local",
          userId: result.user.id,
          role: "owner",
        });
      } catch (e) {
        console.warn("[auth] bootstrap membership", e);
      }
      return c.json({ ...result, ok: true }, 201);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        { error: e.message },
        (e.status ?? 400) as 400 | 409,
      );
    }
  });

  app.post("/v1/auth/login", async (c) => {
    const body = (await c.req.json()) as { email?: string; password?: string };
    try {
      const result = await globalAuthStore.login({
        email: body.email ?? "",
        password: body.password ?? "",
      });
      try {
        const { auditLog, auditContextFromRequest } = await import("./audit.js");
        await auditLog({
          action: "auth.login",
          ...auditContextFromRequest(c),
          actorUserId: result.user.id,
          orgId: result.user.orgId,
          resourceType: "user",
          resourceId: result.user.id,
          outcome: "success",
        });
      } catch {
        /* optional */
      }
      return c.json({ ...result, ok: true });
    } catch (err) {
      try {
        const { auditLog, auditContextFromRequest } = await import("./audit.js");
        await auditLog({
          action: "auth.login",
          ...auditContextFromRequest(c),
          metadata: { email: body.email },
          outcome: "failure",
        });
      } catch {
        /* optional */
      }
      const e = err as Error & { status?: number };
      return c.json({ error: e.message }, (e.status ?? 401) as 400 | 401);
    }
  });

  /**
   * Self-service UX preferences (product tour completion, dismissed tips, …).
   * Merged shallowly into users.preferences JSON.
   */
  app.patch("/v1/auth/me/preferences", async (c) => {
    const user = c.get("user") as { id?: string } | undefined;
    if (!user?.id || user.id === "api_key" || user.id === "dev") {
      return c.json(
        { error: "session required", message: "Sign in with a user account to save preferences." },
        401,
      );
    }
    const body = (await c.req.json()) as { preferences?: Record<string, unknown> };
    if (!body.preferences || typeof body.preferences !== "object" || Array.isArray(body.preferences)) {
      return c.json({ error: "preferences object required" }, 400);
    }
    // Guard size / prototype pollution
    const raw = body.preferences;
    if (Object.keys(raw).length > 40) {
      return c.json({ error: "too many preference keys" }, 400);
    }
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("__") || k === "constructor" || k === "prototype") continue;
      if (typeof k !== "string" || k.length > 64) continue;
      if (
        v === null ||
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        (typeof v === "object" && !Array.isArray(v))
      ) {
        safe[k] = v;
      }
    }
    try {
      const updated = await globalAuthStore.updateUser(user.id, { preferences: safe });
      if (!updated) return c.json({ error: "user not found" }, 404);
      return c.json({ ok: true, preferences: updated.preferences ?? {} });
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: e.message }, (e.status ?? 400) as 400);
    }
  });

  /** Self-service: update display name and/or email for the signed-in user. */
  app.patch("/v1/auth/me", async (c) => {
    const user = c.get("user") as { id?: string; email?: string } | undefined;
    if (!user?.id || user.id === "api_key") {
      return c.json(
        { error: "session required", message: "Sign in with a user account to edit your profile." },
        401,
      );
    }
    const body = (await c.req.json()) as { displayName?: string; email?: string };
    if (body.displayName === undefined && body.email === undefined) {
      return c.json({ error: "displayName or email required" }, 400);
    }
    try {
      const { isKeycloakIdentityMode } = await import("./identity/mode.js");
      const {
        isKeycloakAdminConfigured,
        findUserByEmail,
        updateUserProfile,
      } = await import("./identity/keycloak-admin.js");

      // Keycloak is identity SoT — email/name must update there first or login breaks
      if (isKeycloakIdentityMode()) {
        if (!isKeycloakAdminConfigured()) {
          return c.json(
            {
              error:
                "Identity directory is not configured for profile updates (Keycloak Admin client).",
            },
            503,
          );
        }
        const local = await globalAuthStore.getUserById(user.id);
        const lookupEmail = (local?.email ?? user.email ?? "").trim().toLowerCase();
        if (!lookupEmail) {
          return c.json({ error: "account has no email for identity lookup" }, 400);
        }
        const kc = await findUserByEmail(lookupEmail);
        if (!kc?.id) {
          return c.json(
            {
              error:
                "No matching identity user found. Sign out and sign in again, then retry.",
            },
            404,
          );
        }
        await updateUserProfile(kc.id, {
          email: body.email,
          displayName: body.displayName,
        });
      }

      const updated = await globalAuthStore.updateOwnProfile(user.id, {
        displayName: body.displayName,
        email: body.email,
      });
      return c.json({ user: updated });
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        { error: e.message },
        (e.status ?? 400) as 400 | 401 | 404 | 409 | 502 | 503,
      );
    }
  });

  /**
   * Self-service password change (current password required).
   * Keycloak mode: verifies + sets password in Keycloak (login SoT).
   * Local mode: updates local scrypt hash only.
   */
  app.post("/v1/auth/me/password", async (c) => {
    const user = c.get("user") as { id?: string; email?: string } | undefined;
    if (!user?.id || user.id === "api_key") {
      return c.json(
        { error: "session required", message: "Sign in with a user account to change password." },
        401,
      );
    }
    const body = (await c.req.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: "currentPassword and newPassword required" }, 400);
    }
    try {
      const { isKeycloakIdentityMode } = await import("./identity/mode.js");
      const { isKeycloakAdminConfigured, changeUserPassword } = await import(
        "./identity/keycloak-admin.js"
      );

      if (isKeycloakIdentityMode()) {
        if (!isKeycloakAdminConfigured()) {
          return c.json(
            {
              error:
                "Identity directory is not configured for password changes (Keycloak Admin client).",
            },
            503,
          );
        }
        const local = await globalAuthStore.getUserById(user.id);
        const email = (local?.email ?? user.email ?? "").trim().toLowerCase();
        if (!email) {
          return c.json({ error: "account has no email for identity lookup" }, 400);
        }
        await changeUserPassword(email, body.currentPassword, body.newPassword);
        // Keep local hash in sync (break-glass / local fallback) — never sole SoT
        try {
          await globalAuthStore.changeOwnPassword(
            user.id,
            body.currentPassword,
            body.newPassword,
          );
        } catch {
          // OIDC-provisioned users often have unusable local hashes — set hash directly
          try {
            const { hashPassword } = await import("./auth-file.js");
            const passwordHash = await hashPassword(body.newPassword);
            await globalAuthStore.updateUser(user.id, { passwordHash });
          } catch {
            /* local shadow optional */
          }
        }
        return c.json({
          ok: true,
          message: "Password updated in platform identity directory",
          identity: "keycloak",
        });
      }

      await globalAuthStore.changeOwnPassword(
        user.id,
        body.currentPassword,
        body.newPassword,
      );
      return c.json({ ok: true, message: "Password updated", identity: "local" });
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        { error: e.message },
        (e.status ?? 400) as 400 | 401 | 404 | 502 | 503,
      );
    }
  });

  app.get("/v1/auth/me", async (c) => {
    const user = c.get("user") as
      | {
          id?: string;
          orgId?: string;
          email?: string;
          role?: string;
          preferences?: Record<string, unknown>;
        }
      | undefined;
    if (user) {
      let orgs: Array<{ id: string; name: string; slug?: string; role?: string }> = [];
      let preferences: Record<string, unknown> = user.preferences ?? {};
      try {
        if (user.id && user.id !== "api_key") {
          const { getTenancyStore } = await import("./tenancy/orgs.js");
          const list = await getTenancyStore().listOrgsForUser(user.id);
          orgs = list.map((o) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
            role: o.role,
          }));
          // Preferences live on the durable user row (file or Postgres)
          try {
            const full = await globalAuthStore.getUserById(user.id);
            if (full?.preferences && typeof full.preferences === "object") {
              preferences = full.preferences;
            }
          } catch {
            /* keep empty */
          }
        }
      } catch {
        /* ignore */
      }
      const needsOrg = orgs.length === 0 && user.id !== "api_key";
      const primaryOrgId = orgs[0]?.id ?? (user.orgId?.trim() || undefined);
      return c.json({
        user: { ...user, orgId: primaryOrgId, preferences },
        authMode: c.get("authMode") ?? "session",
        orgs,
        needsOrg,
      });
    }
    if (c.get("authMode") === "dev_open") {
      return c.json({
        user: {
          id: "dev",
          email: "dev@local",
          displayName: "Dev (open)",
          name: "Dev (open)",
          role: "admin",
          platformAdmin: true,
          orgId: c.get("orgId") ?? "local",
          createdAt: new Date(0).toISOString(),
        },
        authMode: "dev_open",
        orgs: [],
        needsOrg: false,
      });
    }
    return c.json({ user: null, authMode: "anonymous", orgs: [], needsOrg: false });
  });

  /**
   * End Codesteward session. In Keycloak/OIDC mode also returns idpLogoutUrl so the
   * browser can hit the IdP end_session endpoint (otherwise SSO cookie silently re-logs in).
   */
  app.post("/v1/auth/logout", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    let body: { idToken?: string; postLogoutRedirectUri?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* empty body ok */
    }
    if (bearer) await globalAuthStore.logout(bearer);

    let idpLogoutUrl: string | null = null;
    try {
      const { isKeycloakIdentityMode } = await import("./identity/mode.js");
      const { getOidcEnvConfig, buildOidcLogoutUrl, takeOidcIdTokenForSession } = await import(
        "./auth/oidc.js"
      );
      if (isKeycloakIdentityMode() && getOidcEnvConfig()) {
        const idTokenHint =
          body.idToken?.trim() ||
          (bearer ? takeOidcIdTokenForSession(bearer) : undefined);
        idpLogoutUrl = await buildOidcLogoutUrl({
          idTokenHint,
          postLogoutRedirectUri: body.postLogoutRedirectUri,
        });
      }
    } catch {
      /* local-only logout still ok */
    }
    return c.json({ ok: true, idpLogoutUrl: idpLogoutUrl ?? undefined });
  });


  // Sessions (org-scoped — never global)
  // listLive: worker writes Postgres; API process must not serve stale in-memory cache
  app.get("/v1/sessions", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const sessions = await globalSessionStore.listLive({ orgId });
    return c.json({ sessions });
  });

  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? body.orgId;
    try {
      const { requireOrgEntitled } = await import("./license.js");
      if (body.riskTier === "thorough" || body.depth === "thorough") {
        await requireOrgEntitled(String(orgId ?? "local"), "thoroughDiscourse");
      }
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    // Normalize mode-specific fields before schema (hard gate vs stewardship split)
    const mode = body.mode === "stewardship" || body.mode === "steward" ? "stewardship" : body.mode;
    let normalized: Record<string, unknown> = { ...body, mode, orgId: orgId ?? body.orgId };
    if (mode === "stewardship") {
      if (body.prNumber != null || body.pr != null) {
        return c.json(
          {
            error: "prNumber not allowed for stewardship",
            message:
              "Stewardship audits a single branch/repo tip. To review a PR or compare two branches, open a PR and use POST /v1/reviews/gate.",
          },
          400,
        );
      }
      delete normalized.prNumber;
      delete normalized.pr;
    }
    if (mode === "gate") {
      const prRaw = body.prNumber ?? body.pr;
      const prNumber =
        typeof prRaw === "number"
          ? prRaw
          : typeof prRaw === "string" && prRaw.trim()
            ? Number(prRaw.trim())
            : undefined;
      if (!prNumber || !Number.isFinite(prNumber) || prNumber < 1) {
        return c.json(
          {
            error: "prNumber is required for gate reviews",
            message:
              "Gate reviews a pull-request diff only. Provide prNumber, or use mode=stewardship for a branch/repo audit without a PR.",
          },
          400,
        );
      }
      normalized = { ...normalized, prNumber, mode: "gate" };
    }
    const req = CreateSessionRequestSchema.parse(normalized);
    const session = globalSessionStore.create(req);
    return c.json({ session }, 201);
  });

  app.get("/v1/sessions/:id", async (c) => {
    const session = await globalSessionStore.getLive(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const orgId = c.get("orgId") ?? "local";
    if ((session.orgId ?? "local") !== orgId && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "session not in active org" }, 403);
    }
    return c.json({ session });
  });

  app.post("/v1/sessions/:id/cancel", (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const updated = globalSessionStore.update(session.id, {
      status: "cancelled",
      stage: "cancelled",
    });
    return c.json({ session: updated });
  });

  /**
   * Resume an incomplete session from its last successful checkpoint.
   * Re-enqueues a job; worker runs orchestrator with resume=true.
   */
  app.post("/v1/sessions/:id/resume", async (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }

    const { isSessionResumable, globalCheckpointStore, resolveSelfHealConfig } =
      await import("@codesteward/agents");
    const heal = resolveSelfHealConfig();
    const checkpoint = await globalCheckpointStore.load(session.id);

    if (
      !isSessionResumable({
        status: session.status,
        stage: session.stage,
        units: checkpoint?.units ?? session.units,
        resumeAttempts: session.resumeAttempts,
        maxGlobalRetries: heal.maxGlobalRetries,
      })
    ) {
      return c.json(
        {
          error: "session not resumable",
          status: session.status,
          stage: session.stage,
          resumeAttempts: session.resumeAttempts ?? 0,
          maxGlobalRetries: heal.maxGlobalRetries,
          hasCheckpoint: Boolean(checkpoint),
        },
        409,
      );
    }

    const attempts = (session.resumeAttempts ?? 0) + 1;
    const { failureSummary: _dropFailSummary, ...metaRest } = (session.metadata ??
      {}) as Record<string, unknown> & { failureSummary?: unknown };
    const updated = globalSessionStore.update(session.id, {
      status: "running",
      stage:
        session.stage === "failed" || session.stage === "cancelled"
          ? "specialists"
          : session.stage,
      resumeAttempts: attempts,
      // Clear terminal failure so UI does not keep showing the previous error
      error: undefined,
      completedAt: undefined,
      verdict: undefined,
      metadata: {
        ...metaRest,
        resumeFromCheckpoint: true,
      },
    });

    const job = await globalQueue.enqueue({
      sessionId: session.id,
      mode: session.mode,
      tenantId: session.tenantId,
      repoId: session.repoId,
      repoPath: session.repoPath,
      baseSha: session.baseSha,
      headSha: session.headSha,
      baseBranch: session.baseBranch,
      prNumber: session.prNumber,
      riskTier: session.riskTier,
      depth: session.depth,
      paths:
        (session.metadata.paths as string[] | undefined) ??
        checkpoint?.job.paths,
    });

    globalSessionStore.pushEvent(session.id, {
      type: "log",
      sessionId: session.id,
      level: "info",
      message: `Manual resume #${attempts} enqueued job ${job.id}`,
      ts: new Date().toISOString(),
    });

    return c.json({
      session: globalSessionStore.get(session.id) ?? updated,
      job,
      checkpoint: checkpoint
        ? {
            stage: checkpoint.stage,
            completedUnitIds: checkpoint.completedUnitIds,
            failedUnitIds: checkpoint.failedUnitIds,
            skippedUnitIds: checkpoint.skippedUnitIds,
            partialFindingCount: checkpoint.partialFindingCount,
            updatedAt: checkpoint.updatedAt,
          }
        : session.checkpoint ?? null,
      resumeAttempts: attempts,
    });
  });

  /** Agent failure log (self-heal diagnostics) for a session. */
  app.get("/v1/sessions/:id/failures", async (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);

    const { globalCheckpointStore } = await import("@codesteward/agents");
    const checkpoint = await globalCheckpointStore.load(session.id);
    const failures = checkpoint?.failureLog?.length
      ? checkpoint.failureLog
      : (session.failureLog ?? []);

    return c.json({
      sessionId: session.id,
      status: session.status,
      stage: session.stage,
      resumeAttempts: session.resumeAttempts ?? 0,
      failures,
      summary: {
        total: failures.length,
        recovered: failures.filter((f) => f.recovered).length,
        open: failures.filter((f) => !f.recovered).length,
      },
    });
  });

  /** Review-run forensics: code provenance, specialist runs, zero-findings rationale. */
  app.get("/v1/sessions/:id/audit", async (c) => {
    const session = await globalSessionStore.getLive(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const audit =
      session.audit ??
      (session.metadata?.audit as typeof session.audit | undefined) ??
      null;
    if (!audit) {
      const notes = session.metadata?.workspaceNotes;
      const codeSource = session.metadata?.codeSource;
      const extra =
        codeSource || notes
          ? ` Workspace was source=${String(codeSource ?? "?")}` +
            (Array.isArray(notes) && notes.length
              ? `; notes: ${notes.slice(0, 2).join("; ")}`
              : "") +
            "."
          : "";
      return c.json(
        {
          sessionId: session.id,
          audit: null,
          hint:
            "No Session Audit payload was persisted for this run (worker may have been on a stale build, or the job completed without the audit collector). Re-run the review after upgrading API+worker." +
            extra,
        },
        200,
      );
    }
    return c.json({ sessionId: session.id, audit });
  });

  app.post("/v1/sessions/:id/start", async (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    // Enforce mode contract at start (session may have been created before validation hardened)
    if (session.mode === "gate" && !(session.prNumber && session.prNumber >= 1)) {
      return c.json(
        {
          error: "prNumber is required for gate reviews",
          message:
            "This gate session has no PR number. Create a new gate with prNumber, or use stewardship for branch audits.",
        },
        400,
      );
    }
    if (session.mode === "stewardship" && session.prNumber != null) {
      return c.json(
        {
          error: "prNumber not allowed for stewardship",
          message:
            "Stewardship sessions cannot carry a PR. Open a PR and start a gate review to compare branches.",
        },
        400,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      paths?: string[];
    };
    const paths =
      body.paths ?? (session.metadata.paths as string[] | undefined);
    const job = await globalQueue.enqueue(
      withJobDefaults({ ...session, mode: session.mode }, paths),
    );
    const waiting = !isInlineWorkerEnabled();
    globalSessionStore.update(session.id, {
      status: waiting ? "pending" : "running",
      stage: "queued",
      repoPath: job.repoPath ?? session.repoPath,
      metadata: {
        ...session.metadata,
        paths: job.paths,
        waitingForWorker: waiting,
        jobId: job.id,
      },
    });
    return c.json({ job, session: globalSessionStore.get(session.id) });
  });

  // Convenience: create + start gate/stewardship
  app.post("/v1/reviews/gate", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? body.orgId;
    try {
      const { requireOrgEntitled } = await import("./license.js");
      if (body.riskTier === "thorough" || body.depth === "thorough") {
        await requireOrgEntitled(String(orgId ?? "local"), "thoroughDiscourse");
      }
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    // Gate is a PR merge check only — PR number required; base/head come from SCM PR.
    const prRaw = body.prNumber ?? body.pr;
    const prNumber =
      typeof prRaw === "number"
        ? prRaw
        : typeof prRaw === "string" && prRaw.trim()
          ? Number(prRaw.trim())
          : undefined;
    if (!prNumber || !Number.isFinite(prNumber) || prNumber < 1) {
      return c.json(
        {
          error: "prNumber is required for gate reviews",
          message:
            "Gate reviews a pull-request diff only (base…head from the PR). Provide prNumber. To audit a branch without a PR, use POST /v1/reviews/stewardship. To compare two branches, open a PR first.",
        },
        400,
      );
    }
    // Free-form branch pairs do not replace a PR — ignore client head/base overrides for identity
    // (worker still may use them as hints; session stores PR as source of truth)
    const req = CreateSessionRequestSchema.parse({
      ...body,
      prNumber,
      mode: "gate",
      orgId: orgId ?? body.orgId,
      repoPath: body.repoPath ?? process.env.REPO_PATH ?? process.cwd(),
      paths: body.paths?.length ? body.paths : ["."],
    });
    const session = globalSessionStore.create(req);
    const job = await globalQueue.enqueue(withJobDefaults({ ...session, mode: "gate" }, req.paths));
    const waiting = !isInlineWorkerEnabled();
    globalSessionStore.update(session.id, {
      status: waiting ? "pending" : "running",
      stage: "queued",
      repoPath: job.repoPath,
      metadata: {
        ...session.metadata,
        paths: job.paths,
        waitingForWorker: waiting,
        jobId: job.id,
        modeContract: "gate_pr_only",
      },
    });
    return c.json({ session: globalSessionStore.get(session.id), job }, 201);
  });

  app.post("/v1/reviews/stewardship", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? body.orgId;
    try {
      const { requireOrgEntitled } = await import("./license.js");
      if (body.riskTier === "thorough" || body.depth === "thorough") {
        await requireOrgEntitled(String(orgId ?? "local"), "thoroughDiscourse");
      }
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    // Hard separation: stewardship never accepts a PR (branch compare = open a PR + gate)
    if (body.prNumber != null || body.pr != null) {
      return c.json(
        {
          error: "prNumber not allowed for stewardship",
          message:
            "Stewardship audits one branch/repo tip (no PR). To review a PR or compare two branches, open a PR and use POST /v1/reviews/gate.",
        },
        400,
      );
    }
    const branch =
      (typeof body.headBranch === "string" && body.headBranch.trim()) ||
      (typeof body.baseBranch === "string" && body.baseBranch.trim()) ||
      "main";
    const req = CreateSessionRequestSchema.parse({
      ...body,
      prNumber: undefined,
      mode: "stewardship",
      orgId: orgId ?? body.orgId,
      // Single tip to audit — not a base…head PR range
      headBranch: branch,
      baseBranch: body.baseBranch?.trim() || branch,
      repoPath: body.repoPath ?? process.env.REPO_PATH ?? process.cwd(),
      paths: body.paths?.length ? body.paths : ["."],
    });
    const session = globalSessionStore.create(req);
    const job = await globalQueue.enqueue(withJobDefaults({ ...session, mode: "stewardship" }, req.paths));
    const waiting = !isInlineWorkerEnabled();
    globalSessionStore.update(session.id, {
      status: waiting ? "pending" : "running",
      stage: "queued",
      repoPath: job.repoPath,
      metadata: {
        ...session.metadata,
        paths: job.paths,
        waitingForWorker: waiting,
        jobId: job.id,
        modeContract: "stewardship_branch_only",
      },
    });
    return c.json({ session: globalSessionStore.get(session.id), job }, 201);
  });

  // Findings (org-scoped)
  app.get("/v1/findings", async (c) => {
    const sessionId = c.req.query("sessionId");
    const severity = c.req.query("severity");
    const status = c.req.query("status");
    const repoId = c.req.query("repoId");
    const orgId = c.get("orgId") ?? "local";
    const list = await findingsStore.list({
      sessionId: sessionId ?? undefined,
      severity: severity as never,
      status: status as never,
      repoId: repoId ?? undefined,
      orgId,
    });
    // Distinct repos for filter UI (always org-wide, not limited by current filter)
    const allForRepos = await findingsStore.list({ orgId });
    const repos = [
      ...new Set(
        allForRepos
          .map((f) => f.repoId)
          .filter((r): r is string => Boolean(r)),
      ),
    ].sort((a, b) => a.localeCompare(b));
    return c.json({ findings: list, repos });
  });

  /**
   * Session reports index — completed reviews with human-readable report payloads.
   * Supports re-run comparison by repoId (+ optional mode).
   */
  app.get("/v1/reports", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const repoId = c.req.query("repoId") ?? undefined;
    const mode = c.req.query("mode") ?? undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 300);
    const sessions = await globalSessionStore.listLive({ orgId });
    const reports = sessions
      .filter((s) => {
        const report = s.metadata?.report;
        const hasReport =
          report &&
          typeof report === "object" &&
          typeof (report as { markdown?: string }).markdown === "string";
        if (!hasReport) return false;
        if (repoId && s.repoId !== repoId) return false;
        if (mode && s.mode !== mode) return false;
        return true;
      })
      .map((s) => {
        const report = s.metadata?.report as {
          markdown?: string;
          headline?: string;
          generatedAt?: string;
          llmNarrative?: boolean;
          findingCount?: number;
          verdict?: string;
          severityCounts?: Record<string, number>;
        };
        return {
          sessionId: s.id,
          repoId: s.repoId,
          mode: s.mode,
          status: s.status,
          verdict: s.verdict ?? report?.verdict,
          riskTier: s.riskTier,
          depth: s.depth,
          baseBranch: s.baseBranch,
          headBranch: s.headBranch,
          prNumber: s.prNumber,
          createdAt: s.createdAt,
          completedAt: s.completedAt,
          updatedAt: s.updatedAt,
          headline: report?.headline ?? s.metadata?.reportHeadline,
          findingCount: report?.findingCount,
          severityCounts: report?.severityCounts,
          llmNarrative: report?.llmNarrative,
          generatedAt: report?.generatedAt,
          markdown: report?.markdown,
          codeSource: s.metadata?.codeSource,
        };
      })
      .sort((a, b) => {
        const ta = Date.parse(a.completedAt ?? a.updatedAt ?? a.createdAt);
        const tb = Date.parse(b.completedAt ?? b.updatedAt ?? b.createdAt);
        return tb - ta;
      })
      .slice(0, limit);

    const repos = [
      ...new Set(reports.map((r) => r.repoId).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));

    return c.json({ reports, repos, total: reports.length });
  });

  app.get("/v1/sessions/:id/findings", async (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const list = await findingsStore.list({
      sessionId: c.req.param("id"),
      orgId: c.get("orgId") ?? "local",
    });
    return c.json({ findings: list });
  });

  app.get("/v1/findings/:id", async (c) => {
    const f = await findingsStore.get(c.req.param("id"));
    if (!f) return c.json({ error: "not found" }, 404);
    const orgId = c.get("orgId") ?? "local";
    if ((f.orgId ?? "local") !== orgId && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "finding not in active org" }, 403);
    }
    return c.json({ finding: f });
  });

  app.patch("/v1/findings/:id", async (c) => {
    const existing = await findingsStore.get(c.req.param("id"));
    if (!existing) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(existing.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const body = await c.req.json();
    const f = await findingsStore.update(c.req.param("id"), body);

    // Status → learning: wontfix / false_positive / dismissed train suppression for this org only
    const nextStatus = typeof body.status === "string" ? body.status : undefined;
    const learnStatuses = new Set(["wontfix", "false_positive", "dismissed"]);
    if (
      nextStatus &&
      learnStatuses.has(nextStatus) &&
      nextStatus !== existing.status &&
      existing.fingerprint
    ) {
      try {
        await learningStore.addMemory({
          orgId: existing.orgId ?? c.get("orgId") ?? "local",
          repoId: existing.repoId,
          kind: nextStatus === "false_positive" ? "false_positive" : "dismissal",
          polarity: "negative",
          fingerprint: existing.fingerprint,
          pattern: existing.title,
          title: existing.title?.slice(0, 120),
          body: `User set status to ${nextStatus} on finding ${existing.id}`,
          source: `status:${nextStatus}`,
          weight: 1,
        });
      } catch {
        /* learning optional */
      }
    }

    return c.json({ finding: f });
  });

  // Cross-repo links (always org-scoped via X-Org-Id / middleware)
  app.get("/v1/org/repo-links", (c) => {
    const orgId = c.get("orgId") ?? c.req.query("orgId") ?? "local";
    const links = globalSessionStore.listLinks().filter((l) => (l.orgId ?? "local") === orgId);
    return c.json({ links });
  });

  app.get("/v1/org/repo-links/:id", (c) => {
    const orgId = c.get("orgId") ?? "local";
    const link = globalSessionStore.listLinks().find((l) => l.id === c.req.param("id"));
    if (!link) return c.json({ error: "not found" }, 404);
    if ((link.orgId ?? "local") !== orgId && c.get("authMode") !== "dev_open") {
      return c.json(orgForbidden(), 403);
    }
    return c.json({ link });
  });

  app.put("/v1/org/repo-links", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? body.orgId ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "crossRepo");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const { CrossRepoLinkSchema } = await import("@codesteward/core");
    const partial = {
      orgId,
      fromRepoId: body.fromRepoId,
      toRepoId: body.toRepoId,
      edgeType: body.edgeType ?? "depends_on_api",
      pathFilters: body.pathFilters ?? { from: [], to: [] },
      fromRepoPath: body.fromRepoPath,
      toRepoPath: body.toRepoPath,
      hints: body.hints ?? {},
      maxDepth: body.maxDepth ?? 2,
      tokenBudget: body.tokenBudget ?? 50_000,
      enabled: body.enabled ?? true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      id: body.id ?? "tmp",
    };
    // Validate shape (id rewritten by store)
    CrossRepoLinkSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({
      orgId: partial.orgId,
      fromRepoId: partial.fromRepoId,
      toRepoId: partial.toRepoId,
      edgeType: partial.edgeType,
      pathFilters: partial.pathFilters,
      fromRepoPath: partial.fromRepoPath,
      toRepoPath: partial.toRepoPath,
      hints: partial.hints,
      maxDepth: partial.maxDepth,
      tokenBudget: partial.tokenBudget,
      enabled: partial.enabled,
    });
    const link = globalSessionStore.addLink({ ...body, orgId });
    return c.json({ link }, 201);
  });

  app.patch("/v1/org/repo-links/:id", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const existing = globalSessionStore.listLinks().find((l) => l.id === c.req.param("id"));
    if (!existing) return c.json({ error: "not found" }, 404);
    if ((existing.orgId ?? "local") !== orgId && c.get("authMode") !== "dev_open") {
      return c.json(orgForbidden(), 403);
    }
    const body = await c.req.json();
    globalSessionStore.deleteLink(existing.id);
    const link = globalSessionStore.addLink({
      ...existing,
      ...body,
      id: existing.id,
      orgId: existing.orgId ?? orgId,
      fromRepoId: body.fromRepoId ?? existing.fromRepoId,
      toRepoId: body.toRepoId ?? existing.toRepoId,
    });
    return c.json({ link });
  });

  app.delete("/v1/org/repo-links/:id", (c) => {
    const orgId = c.get("orgId") ?? "local";
    const existing = globalSessionStore.listLinks().find((l) => l.id === c.req.param("id"));
    if (!existing) return c.json({ deleted: false });
    if ((existing.orgId ?? "local") !== orgId && c.get("authMode") !== "dev_open") {
      return c.json(orgForbidden(), 403);
    }
    const ok = globalSessionStore.deleteLink(c.req.param("id"));
    return c.json({ deleted: ok });
  });

  /** Preview fan-out for a primary repo */
  app.post("/v1/org/repo-links/preview", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? "local";
    const { planCrossRepoFanOut } = await import("@codesteward/agents");
    const links = globalSessionStore
      .listLinks()
      .filter((l) => (l.orgId ?? "local") === orgId);
    const fan = await planCrossRepoFanOut({
      sessionId: "preview",
      primaryRepoId: body.repoId,
      primaryPaths: body.paths ?? ["."],
      links,
      tenantId: body.tenantId ?? "local",
    });
    return c.json(fan);
  });

  // Providers / models — durable per-org matrix + encrypted provider keys (env is host fallback only)
  app.get("/v1/org/model-profiles", async (c) => {
    const cfg = loadEnvModelConfig();
    const orgId = c.get("orgId") ?? "local";
    const {
      getOrgSettingsStore,
      maskProviders,
      decryptProvidersForRuntime,
    } = await import("./org-settings-store.js");
    const org = await getOrgSettingsStore().get(orgId);
    const runtimeProviders = decryptProvidersForRuntime(org.modelMatrix.providers);
    const roles = [
      "default",
      "judge",
      "security",
      "correctness",
      "evidence",
      "discourse",
      "verifier",
      "prove",
      "summary",
      "coordinator",
      "generalist",
      "performance",
      "testing",
      "rules",
      "requirements",
    ];
    // Per-stage matrix is provider + model only. Keys live under org providers (encrypted).
    // apiKeyRef/env:VAR is not part of the org product model (host STEW_MODEL_ROLE_MATRIX only).
    const roleMatrix: Record<string, Record<string, unknown>> = {};
    for (const [role, row] of Object.entries(org.modelMatrix.roles ?? {})) {
      const r = row as { provider?: string; model?: string; baseUrl?: string };
      roleMatrix[role] = {
        provider: r.provider,
        model: r.model,
        baseUrl: r.baseUrl,
      };
    }
    const { isEntitled } = await import("./license.js");
    const providersMasked = maskProviders(org.modelMatrix.providers);
    return c.json({
      provider: org.modelMatrix.defaultProvider ?? cfg.provider,
      model: org.modelMatrix.defaultModel ?? cfg.model,
      strongModel: org.modelMatrix.strongModel ?? cfg.strongModel,
      cheapModel: org.modelMatrix.cheapModel ?? cfg.cheapModel,
      hasOpenAI: Boolean(runtimeProviders.openai?.apiKey || cfg.openaiApiKey),
      hasAnthropic: Boolean(runtimeProviders.anthropic?.apiKey || cfg.anthropicApiKey),
      hasXai: Boolean(runtimeProviders.xai?.apiKey || cfg.xaiApiKey),
      hasOpenRouter: Boolean(
        runtimeProviders.openrouter?.apiKey || cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY,
      ),
      litellmBaseUrl:
        runtimeProviders.litellm?.baseUrl ?? cfg.litellmBaseUrl,
      openaiBaseUrl:
        runtimeProviders.openai?.baseUrl ?? cfg.openaiBaseUrl,
      openrouterBaseUrl:
        runtimeProviders.openrouter?.baseUrl ??
        cfg.openrouterBaseUrl ??
        "https://openrouter.ai/api/v1",
      providers: providersMasked,
      roleMatrix,
      availableRoles: roles,
      roleNotes: {
        judge:
          "Noise/judge stack + strong-tier routing — not a separate multi-model adjudication LLM stage",
      },
      langfuseEnabled:
        Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) &&
        isEntitled("langfuse"),
      source: "org+env",
      note:
        "Provider API keys are stored per org (encrypted) and apply to all stages that use that provider. Host env is fallback only for single-tenant deploys. Per-stage matrix sets provider/model only — not separate keys.",
    });
  });

  /**
   * Org-overridable runtime only (e.g. STEW_SUGGESTED_CODE_FIXES, STEW_PUBLISH_SARIF).
   * Install-wide knobs live under /v1/platform/runtime-config.
   */
  app.get("/v1/org/runtime-config", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const { getOrgRuntimeConfigView } = await import("./runtime-config.js");
    return c.json(await getOrgRuntimeConfigView(String(orgId)));
  });

  app.put("/v1/org/runtime-config", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const role = c.get("role");
    const authMode = c.get("authMode") as string | undefined;
    // Org admin (or platform/API key break-glass)
    if (
      role !== "admin" &&
      role !== "owner" &&
      authMode !== "api_key" &&
      authMode !== "dev_open"
    ) {
      return c.json(
        {
          error: "forbidden",
          message: "Organization admin required to change tenant review preferences",
        },
        403,
      );
    }
    const body = (await c.req.json()) as {
      values?: Record<string, string | null | undefined>;
    };
    if (!body.values || typeof body.values !== "object") {
      return c.json({ error: "body.values required" }, 400);
    }
    try {
      const { putOrgRuntimeConfig } = await import("./runtime-config.js");
      const saved = await putOrgRuntimeConfig(String(orgId), body.values);
      try {
        const { auditLog } = await import("./audit.js");
        await auditLog({
          orgId: String(orgId),
          action: "org.runtime_config.update",
          actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
          metadata: { keys: Object.keys(body.values) },
        });
      } catch {
        /* optional */
      }
      return c.json(saved);
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 403) {
        return c.json({ error: e.message, code: e.code }, 403);
      }
      throw err;
    }
  });

  /** Install-wide runtime knobs (clone, DeepAgents, graph, worker, …). */
  /**
   * Platform operator performance analytics (all orgs, last N days).
   * Not tenant product analytics — for install operators / SRE.
   */
  app.get("/v1/platform/analytics", async (c) => {
    try {
      const user = c.get("user");
      const authMode = c.get("authMode") as string | undefined;
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
      const days = Number(c.req.query("days") ?? 14);
      const { buildPlatformAnalytics } = await import("./platform-analytics.js");
      const analytics = await buildPlatformAnalytics({
        sessions: globalSessionStore,
        queue: globalQueue,
        days: Number.isFinite(days) ? days : 14,
      });
      return c.json(analytics);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) return c.json({ error: e.message }, 403);
      throw err;
    }
  });

  app.get("/v1/platform/runtime-config", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    const { getPlatformRuntimeConfigView } = await import("./runtime-config.js");
    return c.json(await getPlatformRuntimeConfigView());
  });

  app.put("/v1/platform/runtime-config", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        {
          error: "forbidden",
          message:
            e.message ||
            "Platform operator required to change install runtime knobs.",
        },
        403,
      );
    }
    const body = (await c.req.json()) as {
      values?: Record<string, string | null | undefined>;
    };
    if (!body.values || typeof body.values !== "object") {
      return c.json({ error: "body.values required" }, 400);
    }
    const { putPlatformRuntimeConfig } = await import("./runtime-config.js");
    const saved = await putPlatformRuntimeConfig(body.values);
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        orgId: "platform",
        action: "platform.runtime_config.update",
        actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
        metadata: { keys: Object.keys(body.values) },
      });
    } catch {
      /* optional */
    }
    return c.json(saved);
  });

  /**
   * Job queue status (Postgres SoT + optional NATS/Rabbit/Pulsar wake-up broker).
   * Platform operators only — used after broker disaster recovery.
   */
  app.get("/v1/platform/queue", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    await globalQueue.load();
    const status = (await globalQueue.status?.()) ?? {
      queue: globalQueue.describe?.() ?? "unknown",
      broker: null,
      brokerConfigured: false,
      brokerConnected: false,
      pendingInSot: (await globalQueue.list()).length,
      brokerDepth: null,
    };
    return c.json(status);
  });

  /**
   * Re-publish pending Postgres jobs onto the optional broker (wake-up rehydrate).
   * Safe after broker data loss; does not change SoT. Duplicates are OK — claim is in PG.
   */
  app.post("/v1/platform/queue/republish", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        {
          error: "forbidden",
          message:
            e.message ||
            "Platform operator required to republish the install job queue.",
        },
        403,
      );
    }
    let limit: number | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
      if (body.limit != null) limit = Number(body.limit);
    } catch {
      /* empty body OK */
    }
    await globalQueue.load();
    if (!globalQueue.republishPending) {
      return c.json(
        {
          error: "unsupported",
          message: "This queue implementation does not support broker republish.",
        },
        501,
      );
    }
    const result = await globalQueue.republishPending({ limit });
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        orgId: "platform",
        action: "platform.queue.republish",
        actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
        metadata: {
          broker: result.broker,
          pending: result.pending,
          published: result.published,
          failed: result.failed,
          skipped: result.skipped,
          limit: limit ?? 500,
        },
      });
    } catch {
      /* optional */
    }
    return c.json(result);
  });

  app.put("/v1/org/model-profiles", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json()) as {
      defaultProvider?: string;
      defaultModel?: string;
      strongModel?: string;
      cheapModel?: string;
      roles?: Record<
        string,
        { provider?: string; model?: string; baseUrl?: string; apiKeyRef?: string }
      >;
      providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    };
    // Sanitize roles: provider/model/baseUrl only — drop apiKeyRef (keys are org providers)
    const rolesIn = body.roles ?? {};
    const rolesClean: Record<
      string,
      { provider?: string; model?: string; baseUrl?: string }
    > = {};
    for (const [role, row] of Object.entries(rolesIn)) {
      if (!row) continue;
      if (row.apiKeyRef) {
        // Soft-ignore legacy clients still sending env: refs; do not store them on org matrix
        console.warn(
          `[models] ignoring roles.${role}.apiKeyRef for org=${orgId} — use org provider keys`,
        );
      }
      rolesClean[role] = {
        provider: row.provider,
        model: row.model,
        baseUrl: row.baseUrl,
      };
    }
    const { getOrgSettingsStore } = await import("./org-settings-store.js");
    const saved = await getOrgSettingsStore().putModelMatrix(orgId, {
      defaultProvider: body.defaultProvider,
      defaultModel: body.defaultModel,
      strongModel: body.strongModel,
      cheapModel: body.cheapModel,
      roles: rolesClean,
      providers: body.providers as never,
    });
    // Optional single-tenant: paint process env (avoid in multi-org)
    if (process.env.STEW_APPLY_MODEL_ENV === "1") {
      if (body.defaultModel) process.env.MODEL_NAME = body.defaultModel;
      if (body.strongModel) process.env.STEW_MODEL_JUDGE = body.strongModel;
      if (body.cheapModel) process.env.STEW_MODEL_CHEAP = body.cheapModel;
      if (Object.keys(rolesClean).length) {
        process.env.STEW_MODEL_ROLE_MATRIX = JSON.stringify(rolesClean);
      }
    }
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        action: "models.update",
        orgId,
        actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
        resourceType: "model_matrix",
      });
    } catch {
      /* ignore */
    }
    const { maskProviders } = await import("./org-settings-store.js");
    return c.json({
      ok: true,
      modelMatrix: {
        ...saved.modelMatrix,
        providers: maskProviders(saved.modelMatrix.providers),
      },
    });
  });

  /**
   * Org prompt pack — editable specialist prompt components.
   * Learning / runtime slots are locked in the editor and filled at review time.
   */
  app.get("/v1/org/prompt-pack", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const {
      createDefaultPromptPack,
      mergePromptPack,
      listComponentCatalog,
      previewRolePrompt,
      getPromptLimitPolicy,
    } = await import("@codesteward/agents");
    const { getOrgSettingsStore } = await import("./org-settings-store.js");
    const { learningStore } = await import("./shared-stores.js");
    const defaults = createDefaultPromptPack();
    const doc = await getOrgSettingsStore().get(orgId);
    const effective = doc.promptPack
      ? mergePromptPack(defaults, doc.promptPack as never)
      : defaults;
    const role = c.req.query("role") ?? "security";
    let learningPreview = "";
    try {
      const { buildOrgLearningPrompt } = await import("@codesteward/learning");
      learningPreview = await buildOrgLearningPrompt(learningStore, {
        orgId,
        repoId: c.req.query("repoId") ?? undefined,
      });
    } catch {
      /* optional */
    }
    const preview = previewRolePrompt(effective, role, {
      org_learning:
        learningPreview ||
        "[no org learning yet — 👎 findings or add memories on Learnings]",
      severity_floor: "medium",
    });
    return c.json({
      defaults,
      pack: doc.promptPack ?? null,
      effective,
      catalog: listComponentCatalog(),
      limits: getPromptLimitPolicy(),
      roles: Object.keys(effective.roles),
      previewRole: role,
      preview,
      learningPreviewChars: learningPreview.length,
      note:
        "Editable components can be customized per org (with character limits). Org learning, path rules, and JSON output format are locked.",
    });
  });

  app.put("/v1/org/prompt-pack", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const role = c.get("role") as string | undefined;
    const authMode = c.get("authMode") as string | undefined;
    if (authMode === "session" && role && role !== "admin") {
      return c.json({ error: "admin role required" }, 403);
    }
    const body = (await c.req.json()) as {
      pack?: unknown;
      reset?: boolean;
    };
    const {
      createDefaultPromptPack,
      mergePromptPack,
      sanitizePromptPackInput,
    } = await import("@codesteward/agents");
    const { getOrgSettingsStore } = await import("./org-settings-store.js");
    const defaults = createDefaultPromptPack();
    if (body.reset) {
      await getOrgSettingsStore().putPromptPack(orgId, null);
      return c.json({ ok: true, pack: null, effective: defaults, reset: true });
    }
    if (!body.pack || typeof body.pack !== "object") {
      return c.json({ error: "pack required (or reset: true)" }, 400);
    }
    const sanitized = sanitizePromptPackInput(body.pack as never, defaults);
    const effective = mergePromptPack(defaults, sanitized);
    await getOrgSettingsStore().putPromptPack(orgId, effective as never);
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        action: "prompts.update",
        orgId,
        actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
        resourceType: "prompt_pack",
      });
    } catch {
      /* ignore */
    }
    return c.json({ ok: true, pack: effective, effective });
  });

  app.post("/v1/org/prompt-pack/preview", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json().catch(() => ({}))) as {
      role?: string;
      pack?: unknown;
      repoId?: string;
    };
    const {
      createDefaultPromptPack,
      mergePromptPack,
      previewRolePrompt,
      sanitizePromptPackInput,
    } = await import("@codesteward/agents");
    const { getOrgSettingsStore } = await import("./org-settings-store.js");
    const { learningStore } = await import("./shared-stores.js");
    const defaults = createDefaultPromptPack();
    const doc = await getOrgSettingsStore().get(orgId);
    const base = doc.promptPack
      ? mergePromptPack(defaults, doc.promptPack as never)
      : defaults;
    const pack = body.pack
      ? mergePromptPack(defaults, sanitizePromptPackInput(body.pack as never, defaults))
      : base;
    let learningPreview = "";
    try {
      const { buildOrgLearningPrompt } = await import("@codesteward/learning");
      learningPreview = await buildOrgLearningPrompt(learningStore, {
        orgId,
        repoId: body.repoId,
      });
    } catch {
      /* optional */
    }
    const role = body.role ?? "security";
    const preview = previewRolePrompt(pack, role, {
      org_learning:
        learningPreview ||
        "[no org learning yet — feedback will appear here at review time]",
    });
    return c.json({
      role,
      preview,
      learningPreviewChars: learningPreview.length,
      learningInjected: Boolean(learningPreview),
    });
  });

  app.post("/v1/org/model-profiles/test", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json().catch(() => ({}))) as { role?: string };
    const { createOrgModelRouter } = await import("./org-model-router.js");
    const { router, fromOrgMatrix } = await createOrgModelRouter(String(orgId));
    const role = (body.role ?? "default") as "default";
    const model = router.createChatModel(role);
    const res = await model.complete({
      messages: [{ role: "user", content: "Reply with pong" }],
      maxTokens: 16,
    });
    return c.json({
      ok: true,
      content: res.content.slice(0, 200),
      model: res.model,
      provider: res.provider,
      role: body.role ?? "default",
      orgId: String(orgId),
      fromOrgMatrix,
    });
  });

  /** Admin / SIEM audit log (who changed connectors, models, members, SCIM, …). */
  app.get("/v1/org/audit", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "audit");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const { listAuditEvents, countAuditEvents } = await import("./audit.js");
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const action = c.req.query("action") ?? undefined;
    const actionPrefix = c.req.query("actionPrefix") ?? undefined;
    const actorUserId = c.req.query("actor") ?? undefined;
    const resourceType = c.req.query("resourceType") ?? undefined;
    const outcome = c.req.query("outcome") ?? undefined;
    const since = c.req.query("since") ?? undefined;
    const until = c.req.query("until") ?? undefined;
    const format = c.req.query("format") ?? "json";
    const filter = {
      orgId,
      limit,
      offset,
      action,
      actionPrefix,
      actorUserId,
      resourceType,
      outcome,
      since,
      until,
    };
    const events = await listAuditEvents(filter);
    if (format === "ndjson") {
      const body = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
      return new Response(body, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-${orgId}.ndjson"`,
        },
      });
    }
    const total = await countAuditEvents(filter);
    return c.json({
      orgId,
      events,
      count: events.length,
      total,
      limit,
      offset,
      retentionDays: Number(process.env.STEW_AUDIT_RETENTION_DAYS ?? 365),
    });
  });

  /** Prune audit events older than retention (admin). */
  app.post("/v1/org/audit/prune", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json().catch(() => ({}))) as { retentionDays?: number };
    const { pruneAuditEvents, auditLog } = await import("./audit.js");
    const deleted = await pruneAuditEvents({
      orgId,
      retentionDays: body.retentionDays,
    });
    await auditLog({
      action: "audit.prune",
      orgId,
      actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
      resourceType: "audit",
      metadata: { deleted, retentionDays: body.retentionDays },
    });
    return c.json({ ok: true, deleted });
  });

  /** SaaS billing status + plan catalog (empty when control plane unset). */
  app.get("/v1/billing/status", async (c) => {
    const {
      isBillingConfigured,
      billingPublicUrl,
      fetchBillingPlans,
    } = await import("./billing-portal.js");
    const configured = isBillingConfigured();
    const plans = configured ? await fetchBillingPlans() : [];
    return c.json({
      configured,
      saasMode: configured,
      publicUrl: configured ? billingPublicUrl() : null,
      portalPath: "/portal",
      plans,
      note: configured
        ? "Cloud billing control plane is connected. Use Billing in the sidebar or Organization → Plan & billing."
        : "Self-host / no STEW_BILLING_URL — install-wide license only.",
    });
  });

  /**
   * Open the private billing portal for the active org (signed short-lived URL).
   * Browser navigates to STEW_BILLING_PUBLIC_URL/portal?token=…
   */
  app.post("/v1/org/billing/portal", async (c) => {
    const {
      isBillingConfigured,
      signBillingPortalToken,
      buildBillingPortalUrl,
    } = await import("./billing-portal.js");
    if (!isBillingConfigured()) {
      return c.json(
        {
          error: "billing_not_configured",
          message: "Billing portal requires STEW_BILLING_URL (SaaS mode).",
        },
        404,
      );
    }
    const orgId = String(c.get("orgId") ?? "");
    if (!orgId) {
      return c.json(
        { error: "org_required", message: "Select or create an organization first." },
        400,
      );
    }
    const user = c.get("user") as
      | { id?: string; email?: string; role?: string }
      | undefined;
    if (!user?.id || user.id === "api_key") {
      return c.json({ error: "session required" }, 401);
    }
    const orgRole = (c.get("orgRole") as string | undefined) ?? user.role ?? "member";
    let orgName = orgId;
    try {
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      const org = await getTenancyStore().getOrg(orgId);
      if (org?.name) orgName = org.name;
    } catch {
      /* ignore */
    }
    const body = (await c.req.json().catch(() => ({}))) as { returnTo?: string };
    const returnTo =
      body.returnTo?.trim() ||
      process.env.STEW_PUBLIC_URL?.trim() ||
      "http://localhost:9080";
    try {
      const token = signBillingPortalToken({
        orgId,
        orgName,
        userId: user.id,
        email: user.email,
        role: orgRole,
      });
      const url = buildBillingPortalUrl(token, returnTo);
      return c.json({
        url,
        orgId,
        expiresInSeconds: 3600,
        note: "Open this URL in the browser to manage plan and billing profile.",
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json(
        { error: e.message, code: (e as { code?: string }).code },
        (e.status as 503) ?? 500,
      );
    }
  });

  app.get("/v1/org/license", async (c) => {
    const {
      resolveOrgLicense,
      featureMatrix,
      FEATURE_CATALOG,
      licenseFilePath,
      isLicenseOpenMode,
    } = await import("./license.js");
    const orgId = c.get("orgId") ?? "local";
    // Prefer org-scoped resolution (SaaS billing later); open mode short-circuits
    const license = await resolveOrgLicense(String(orgId));
    const open = isLicenseOpenMode() || Boolean(license.openMode);
    const billingConfigured = Boolean(process.env.STEW_BILLING_URL?.trim());
    let plan: {
      id?: string;
      status?: string;
      seats?: number;
      maxSeats?: number;
      customerName?: string;
      source: "billing" | "license" | "open";
    } | null = null;
    if (billingConfigured) {
      try {
        const billingUrl = process.env.STEW_BILLING_URL!.replace(/\/$/, "");
        const res = await fetch(
          `${billingUrl}/v1/orgs/${encodeURIComponent(String(orgId))}/subscription`,
          {
            headers: {
              Accept: "application/json",
              ...(process.env.STEW_BILLING_TOKEN
                ? { Authorization: `Bearer ${process.env.STEW_BILLING_TOKEN}` }
                : {}),
            },
            signal: AbortSignal.timeout(
              Number(process.env.STEW_BILLING_TIMEOUT_MS ?? 3000),
            ),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as {
            subscription?: {
              planId?: string;
              status?: string;
              seats?: number;
              customerName?: string;
            };
          };
          const sub = body.subscription;
          plan = {
            id: sub?.planId ?? license.tier,
            status: sub?.status,
            /** Purchased / included seats (enforced as maxSeats on invites) */
            seats: sub?.seats ?? license.maxSeats,
            maxSeats: license.maxSeats,
            customerName: sub?.customerName ?? license.customer,
            source: "billing",
          };
        }
      } catch {
        plan = { id: license.tier, source: "billing" };
      }
    } else if (open) {
      plan = { id: "open", source: "open" };
    } else {
      plan = { id: license.tier, source: "license", customerName: license.customer };
    }
    return c.json({
      license,
      plan,
      billingConfigured,
      features: featureMatrix(license),
      catalog: FEATURE_CATALOG.map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      openMode: open,
      hideLicenseUi: open || Boolean(license.hideLicenseUi) || billingConfigured,
      upload: open || billingConfigured
        ? {
            path: "PUT /v1/org/license",
            formats: [] as string[],
            note: billingConfigured
              ? "Plan is managed by the cloud control plane (Organization → Plan & billing)."
              : "License management is not available for this install.",
            disabled: true,
          }
        : {
            path: "PUT /v1/org/license",
            formats: [
              "base64url(JSON) with tier, features[], maxSeats, validUntil, …",
              "body.sig when STEW_LICENSE_HMAC is set (signed commercial)",
            ],
            note:
              "Not related to STEW_API_KEY (API auth). Upload a license key string from your vendor or self-issue when HMAC is unset.",
            filePath: licenseFilePath(),
          },
    });
  });

  /** Install / replace license key (admin). Stored under STEW_LICENSE_FILE / .steward-data/license.key */
  app.put("/v1/org/license", async (c) => {
    {
      const { isLicenseOpenMode } = await import("./license.js");
      if (isLicenseOpenMode()) {
        return c.json(
          {
            error: "license_unavailable",
            message: "License install is not available for this install.",
          },
          409,
        );
      }
    }
    // Platform operator only — not tenant org admin
    {
      const authMode = c.get("authMode") as string | undefined;
      const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
      try {
        const { requirePlatformAdmin } = await import("./platform-admin.js");
        requirePlatformAdmin(user ?? null, authMode);
      } catch (err) {
        const e = err as Error & { status?: number };
        return c.json(
          {
            error: "forbidden",
            message:
              e.message ||
              "Platform operator required to install license (tenant admins cannot).",
          },
          403,
        );
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      key?: string;
      licenseKey?: string;
    };
    const key = (body.key ?? body.licenseKey ?? "").trim();
    if (!key) {
      return c.json(
        {
          error: "key required",
          hint: "Paste the full license string (base64url JSON or body.sig). This is not STEW_API_KEY.",
        },
        400,
      );
    }
    const { installLicenseKey, featureMatrix } = await import("./license.js");
    const result = await installLicenseKey(key);
    if (!result.ok) {
      return c.json({ error: result.error, code: "LICENSE_INVALID" }, 400);
    }
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        action: "license.install",
        orgId: c.get("orgId") ?? "local",
        actorUserId: (c.get("user") as { id?: string } | undefined)?.id,
        resourceType: "license",
        metadata: { tier: result.license.tier, source: result.license.source },
      });
    } catch {
      /* ignore */
    }
    return c.json({
      ok: true,
      license: result.license,
      features: featureMatrix(result.license),
    });
  });

  app.delete("/v1/org/license", async (c) => {
    const role = c.get("role") as string | undefined;
    const authMode = c.get("authMode") as string | undefined;
    if (
      role !== "admin" &&
      authMode !== "api_key" &&
      authMode !== "dev_open"
    ) {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const { clearInstalledLicense, resolveLicenseAsync, featureMatrix } =
      await import("./license.js");
    await clearInstalledLicense();
    const license = await resolveLicenseAsync();
    return c.json({ ok: true, license, features: featureMatrix(license) });
  });

  // Connectors
  app.get("/v1/org/connectors", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? c.req.query("orgId") ?? "local";
    return c.json({ connectors: await globalConnectorsStore.listPublic(orgId) });
  });

  app.put("/v1/org/connectors/:type", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const type = c.req.param("type");
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const nested =
      body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? (body.config as Record<string, unknown>)
        : undefined;
    // GitHub App (not PAT) and non-GitHub SCM → enterprise_connectors (Pro+)
    const authMode = String(nested?.authMode ?? body.authMode ?? "");
    const wantsApp =
      type === "github" &&
      (authMode === "github_app" ||
        Boolean(nested?.appId || nested?.privateKeyPem || body.appId));
    const multiScm = ["gitlab", "bitbucket", "azure_devops", "gitea", "azure-devops"].includes(
      type,
    );
    if (wantsApp || multiScm) {
      try {
        const { requireOrgEntitled } = await import("./license.js");
        await requireOrgEntitled(String(orgId), "enterpriseConnectors");
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        if (e.status === 402) {
          return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
        }
        throw err;
      }
    }
    // Platform-enforced GitHub App: block org PEMs and optional PATs
    if (type === "github") {
      try {
        const {
          assertOrgMayConfigureGithubApp,
          assertOrgMayUseGithubPat,
        } = await import("./platform-github-app-store.js");
        if (wantsApp || nested?.privateKeyPem || body.privateKeyPem) {
          await assertOrgMayConfigureGithubApp();
        }
        const hasPat = Boolean(
          (typeof body.token === "string" && body.token) ||
            (typeof nested?.token === "string" && nested.token),
        );
        if (hasPat && !wantsApp) {
          await assertOrgMayUseGithubPat();
        }
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        if (e.status === 403) {
          return c.json({ error: e.message, code: e.code }, 403);
        }
        throw err;
      }
    }
    const cfg = await globalConnectorsStore.upsert(
      type,
      {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        config: nested,
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
        username: typeof body.username === "string" ? body.username : undefined,
        org: typeof body.org === "string" ? body.org : undefined,
        project: typeof body.project === "string" ? body.project : undefined,
        token: typeof body.token === "string" ? body.token : undefined,
        webhookSecret:
          typeof body.webhookSecret === "string" ? body.webhookSecret : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
        extra:
          body.extra && typeof body.extra === "object"
            ? (body.extra as Record<string, string>)
            : undefined,
      },
      orgId,
    );
    try {
      const { auditLog } = await import("./audit.js");
      await auditLog({
        action: "connectors.upsert",
        orgId,
        actorUserId: c.get("user")?.id,
        resourceType: "connector",
        resourceId: type,
        metadata: {
          enabled: cfg.enabled,
          // never log secrets — only which keys were provided
          configKeys: Object.keys(nested ?? body).filter(
            (k) => !/token|secret|password|key/i.test(k),
          ),
        },
      });
    } catch {
      /* ignore */
    }
    const list = await globalConnectorsStore.listPublic(orgId);
    const pub = list.find((x) => x.type === type);
    return c.json({ connector: pub, saved: true, updatedAt: cfg.updatedAt });
  });

  app.delete("/v1/org/connectors/:type", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const type = c.req.param("type");
    const ok = await globalConnectorsStore.delete(type, orgId);
    // GitHub App credentials live in tenancy — clear those too when dropping github
    if (type === "github") {
      try {
        const { getTenancyStore } = await import("./tenancy/orgs.js");
        await getTenancyStore().clearGitHubAppConfig(String(orgId));
      } catch (err) {
        console.warn("[connectors] clear GitHub App with connector delete", err);
      }
    }
    return c.json({ deleted: ok, type });
  });

  app.post("/v1/org/connectors/:type/test", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const type = c.req.param("type");
    const orgId = c.get("orgId") ?? "local";
    const pub = (await globalConnectorsStore.listPublic(orgId)).find((x) => x.type === type);
    try {
      if (type === "graph_mcp") {
        const graph = createGraphClient({ repoId: "test" });
        const status = await graph.status({ repoId: "test" });
        return c.json({ ok: true, type, result: status });
      }
      if (type === "mcp") {
        return c.json({ ok: true, type, result: { note: "MCP server package available" } });
      }
      if (["github", "gitlab", "bitbucket", "azure-devops", "gitea"].includes(type)) {
        const { createOrgScmProvider } = await import("./org-scm.js");
        const scm = await createOrgScmProvider(orgId, type);
        const row = await globalConnectorsStore.getAsync(type, orgId);
        const owner =
          (c.req.query("owner") ||
            (row?.config?.org as string) ||
            (row?.config?.username as string) ||
            "") as string;
        const repos =
          owner
            ? await scm.listRepos(owner)
            : scm.listAuthenticatedRepos
              ? await scm.listAuthenticatedRepos()
              : await scm.listRepos("me");
        return c.json({
          ok: true,
          type,
          result: { repoCount: repos.length, sample: repos.slice(0, 5) },
          connector: pub,
          orgId,
        });
      }
      if (type === "jira") {
        const row = await globalConnectorsStore.getAsync("jira", orgId);
        const base =
          (row?.config?.baseUrl as string) ||
          (row?.config?.url as string) ||
          process.env.JIRA_URL ||
          pub?.baseUrl;
        if (!base) return c.json({ ok: false, error: "JIRA_URL / baseUrl required" }, 400);
        return c.json({ ok: true, type, result: { baseUrl: base, hasToken: pub?.hasToken } });
      }
      if (type === "confluence") {
        const { searchConfluencePages } = await import("./confluence.js");
        const result = await searchConfluencePages("codesteward", { orgId, limit: 3 });
        return c.json({
          ok: result.ok,
          type,
          result: result.ok
            ? { pageCount: result.pages.length, sample: result.pages }
            : { error: result.error },
          connector: pub,
        });
      }
      if (type === "linear") {
        const row = await globalConnectorsStore.getAsync("linear", orgId);
        const token =
          (row?.config?.token as string) || process.env.LINEAR_API_KEY;
        return c.json({
          ok: Boolean(token),
          type,
          result: { hasToken: Boolean(token), note: "Token present; full GraphQL probe not required" },
        });
      }
      return c.json({ ok: true, type, result: { status: pub?.status ?? "unknown" } });
    } catch (err) {
      return c.json(
        {
          ok: false,
          type,
          error: err instanceof Error ? err.message : String(err),
          hint: "Configure token/baseUrl via PUT /v1/org/connectors/" + type,
        },
        400,
      );
    }
  });

  // SCM helpers for UI — always use per-org credentials (no process.env bus)
  app.get("/v1/scm/repos", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const owner = c.req.query("owner") ?? "";
    const providerFilter = c.req.query("provider");
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider, orgHasGithubAuth } = await import("./org-scm.js");
    const providers = ["github", "gitlab", "bitbucket", "azure-devops", "gitea"].filter(
      (p) => !providerFilter || providerFilter === p,
    );
    const repos: Array<{
      provider: string;
      fullName: string;
      defaultBranch: string;
      private: boolean;
      url: string;
    }> = [];
    /** Real failures only — unconfigured providers are silent skips, not errors. */
    const errors: Array<{ provider: string; error: string }> = [];
    const skipped: Array<{ provider: string; reason: string }> = [];
    const publicRows = await globalConnectorsStore.listPublic(orgId);
    let githubAuth: Awaited<ReturnType<typeof orgHasGithubAuth>> | undefined;

    for (const p of providers) {
      const pub = publicRows.find((x) => x.type === p);
      let configured = Boolean(pub?.configured || pub?.hasToken);

      // GitHub App may live only in tenancy (not connector PAT)
      if (p === "github" && !configured) {
        githubAuth = githubAuth ?? (await orgHasGithubAuth(orgId));
        configured = githubAuth.configured;
      }

      // Explicit ?provider= always attempts that provider (useful to surface setup errors)
      const forceTry = Boolean(providerFilter);
      if (!configured && !forceTry) {
        skipped.push({ provider: p, reason: "not_configured" });
        continue;
      }

      try {
        const scm = await createOrgScmProvider(orgId, p);
        const list =
          owner && owner !== "me"
            ? await scm.listRepos(owner)
            : scm.listAuthenticatedRepos
              ? await scm.listAuthenticatedRepos()
              : await scm.listRepos(owner || "me");
        for (const r of list) {
          repos.push({ provider: p, ...r });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Unconfigured is not a user-facing error unless they filtered to this provider
        if (/No SCM connector configured/i.test(msg) && !forceTry) {
          skipped.push({ provider: p, reason: "not_configured" });
          continue;
        }
        errors.push({ provider: p, error: msg });
      }
    }

    // Soft hint only when nothing is configured and no repos found
    if (repos.length === 0 && errors.length === 0 && skipped.length === providers.length) {
      errors.push({
        provider: providerFilter || "scm",
        error:
          "No SCM connectors configured. Connect GitHub / GitLab / etc. under Connectors, then refresh.",
      });
    }

    return c.json({
      repos,
      errors,
      skipped,
      worker: getInlineWorkerStatus(),
      orgId,
    });
  });

  app.get("/v1/scm/prs/:provider/:owner/:repo/:number", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const number = Number(c.req.param("number"));
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      const pr = await scm.getPullRequest(owner, repo, number);
      return c.json({ pr, provider, owner, repo });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          hint: "Configure SCM token on Connectors page",
        },
        400,
      );
    }
  });

  app.get("/v1/scm/prs/:provider/:owner/:repo/:number/diff", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const number = Number(c.req.param("number"));
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      const [files, pr] = await Promise.all([
        scm.getDiff(owner, repo, number),
        scm.getPullRequest(owner, repo, number).catch(() => null),
      ]);
      const unified = files
        .map((f) => {
          const header = [
            `diff --git a/${f.previousPath ?? f.path} b/${f.path}`,
            `--- a/${f.previousPath ?? f.path}`,
            `+++ b/${f.path}`,
          ].join("\n");
          return f.patch ? `${header}\n${f.patch}` : header;
        })
        .join("\n");
      return c.json({
        provider,
        owner,
        repo,
        number,
        pr,
        files,
        diff: unified,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          hint: "No connector/token configured — open Connectors and add a token",
        },
        400,
      );
    }
  });

  app.get("/v1/scm/prs/:provider/:owner/:repo", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      if (!scm.listPullRequests) {
        return c.json({
          prs: [],
          hint: "Provider does not support list; use /:number",
          provider,
          owner,
          repo,
        });
      }
      const prs = await scm.listPullRequests(owner, repo, { state: "open" });
      return c.json({ prs, provider, owner, repo });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : String(err),
          hint: "Configure SCM token on Connectors page",
          prs: [],
        },
        400,
      );
    }
  });


  // SCM routes (task shape): ?provider=github
  app.get("/v1/scm/prs/:owner/:repo/:number/diff", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.query("provider") ?? "github";
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const number = Number(c.req.param("number"));
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      const files = await scm.getDiff(owner, repo, number);
      return c.json({ provider: scm.name, owner, repo, number, files, fileCount: files.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/v1/scm/prs/:owner/:repo/:number", async (c) => {
    // Avoid colliding with provider-in-path routes when first segment is a known provider
    const owner = c.req.param("owner");
    const known = ["github", "gitlab", "bitbucket", "azure-devops", "gitea", "forgejo", "azdo"];
    if (known.includes(owner)) {
      // Let the more specific /:provider/:owner/:repo/:number handle if registered first;
      // when path is /v1/scm/prs/github/org/repo/1 this route shouldn't match task shape.
      // Hono matches in registration order — provider-in-path is registered first.
    }
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.query("provider") ?? "github";
    const repo = c.req.param("repo");
    const number = Number(c.req.param("number"));
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      const pr = await scm.getPullRequest(owner, repo, number);
      return c.json({ provider: scm.name, pr });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/v1/scm/prs/:owner/:repo", async (c) => {
    await globalConnectorsStore.ensureLoaded();
    const orgId = c.get("orgId") ?? "local";
    const { createOrgScmProvider } = await import("./org-scm.js");
    const provider = c.req.query("provider") ?? "github";
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const state = (c.req.query("state") as "open" | "closed" | "all" | undefined) ?? "open";
    try {
      const scm = await createOrgScmProvider(orgId, provider);
      if (!scm.listPullRequests) {
        return c.json({ prs: [], provider: scm.name, owner, repo, hint: "list not supported" });
      }
      const prs = await scm.listPullRequests(owner, repo, { state });
      return c.json({ provider: scm.name, owner, repo, prs });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), prs: [] }, 502);
    }
  });

  // Graph proxy
  app.get("/v1/repos/:repoId/graph/status", async (c) => {
    const graph = createGraphClient({ repoId: c.req.param("repoId") });
    const status = await graph.status({ repoId: c.req.param("repoId") });
    return c.json(status);
  });

  app.post("/v1/repos/:repoId/graph/rebuild", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      repoPath?: string;
      changedFiles?: string[];
    };
    const graph = createGraphClient({ repoId: c.req.param("repoId") });
    const result = await graph.rebuild({
      repoId: c.req.param("repoId"),
      repoPath: body.repoPath,
      changedFiles: body.changedFiles,
    });
    return c.json(result);
  });


  // GitHub App webhooks (raw body required for signature)
  app.post("/v1/webhooks/github", async (c) => {
    const { handleGitHubWebhook, verifyGitHubSignature } = await import("@codesteward/webhooks");
    const { GitHubScm } = await import("@codesteward/scm");
    const rawBody = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // VERIFY FIRST — all events including installation*
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const sig =
      headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
    const strict =
      process.env.STEW_AUTH_STRICT === "1" ||
      process.env.NODE_ENV === "production" ||
      process.env.STEW_REQUIRE_WEBHOOK_SIG === "1";
    if (!webhookSecret || webhookSecret === "dev-insecure") {
      if (strict) {
        return c.json(
          { error: "webhook_secret_required", message: "Set GITHUB_WEBHOOK_SECRET" },
          500,
        );
      }
    } else {
      if (!verifyGitHubSignature(rawBody, sig, webhookSecret)) {
        return c.json({ error: "invalid signature" }, 401);
      }
    }
    // Durable delivery claim (idempotency)
    let ghDeliveryId = String(
      headers["x-github-delivery"] ?? headers["X-GitHub-Delivery"] ?? `anon-${Date.now()}`,
    );
    {
      const { claimDelivery } = await import("./webhook-delivery.js");
      const claim = await claimDelivery({
        provider: "github",
        deliveryId: ghDeliveryId,
        event: headers["x-github-event"] ?? headers["X-GitHub-Event"],
        rawBody,
      });
      ghDeliveryId = claim.deliveryId;
      if (claim.duplicate) {
        return c.json({ ok: true, duplicate: true, deliveryId: ghDeliveryId }, 200);
      }
    }
    // Handle installation lifecycle after verify
    const event = headers["x-github-event"] ?? headers["X-GitHub-Event"];
    if (event === "installation" || event === "installation_repositories") {
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      const tenancy = getTenancyStore();
      try {
        const payload = JSON.parse(rawBody) as {
          action?: string;
          installation?: {
            id?: number;
            account?: { login?: string; type?: string };
          };
        };
        const instId = payload.installation?.id;
        // Map installation to product org if known; else local
        const existing = instId
          ? await tenancy.findInstallationByProviderId("github", String(instId))
          : undefined;
        const productOrgId = existing?.orgId ?? "local";
        if (instId && (payload.action === "deleted" || payload.action === "suspend")) {
          await tenancy.suspendInstallation("github", String(instId));
          if (payload.action === "deleted") {
            await tenancy.deleteInstallation("github", String(instId));
          }
        } else if (instId && payload.installation?.account?.login) {
          await tenancy.upsertInstallation({
            tenantId: "local",
            orgId: productOrgId,
            provider: "github",
            installationId: String(instId),
            accountLogin: payload.installation.account.login,
            accountType: payload.installation.account.type ?? "Organization",
            status: "active",
            authMode: "github_app",
          });
        }
        return c.json({ ok: true, event, action: payload.action }, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // Prefer org-scoped GitHub credentials (installation → product org)
    let scm: InstanceType<typeof GitHubScm>;
    try {
      const { createOrgScmProvider } = await import("./org-scm.js");
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      let webhookOrgId = "local";
      try {
        const payloadPeek = JSON.parse(rawBody) as {
          installation?: { id?: number };
          repository?: { owner?: { login?: string } };
        };
        const instId = payloadPeek.installation?.id;
        if (instId) {
          const inst = await getTenancyStore().findInstallationByProviderId(
            "github",
            String(instId),
          );
          if (inst?.orgId) webhookOrgId = inst.orgId;
        }
      } catch {
        /* ignore */
      }
      scm = (await createOrgScmProvider(webhookOrgId, "github")) as InstanceType<
        typeof GitHubScm
      >;
    } catch {
      scm = new GitHubScm();
    }
    const result = await handleGitHubWebhook(
      {
        // Signature already verified above — pass secret so handler re-checks consistently
        secret: webhookSecret && webhookSecret !== "dev-insecure" ? webhookSecret : (webhookSecret ?? "dev-insecure"),
        scm,
        resolveProductOrgId: async ({ installationId, ownerLogin }) => {
          try {
            const { getTenancyStore } = await import("./tenancy/orgs.js");
            if (installationId) {
              const inst = await getTenancyStore().findInstallationByProviderId(
                "github",
                installationId,
              );
              if (inst?.orgId) return inst.orgId;
            }
            // Optional map: "github-owner:productOrg,..."
            const map = process.env.STEW_SCM_ORG_MAP;
            if (map && ownerLogin) {
              for (const part of map.split(",")) {
                const [scmOwner, org] = part.split(":");
                if (scmOwner === ownerLogin && org) return org.trim();
              }
            }
          } catch {
            /* fall through */
          }
          return process.env.DEFAULT_ORG_ID ?? "local";
        },
        resolveRepoPath: (owner, repo) => {
          const map = process.env.REPO_PATH_MAP; // "owner/repo:/path,..."
          if (!map) return process.env.REPO_PATH;
          for (const part of map.split(",")) {
            const [key, path] = part.split(":");
            if (key === `${owner}/${repo}`) return path;
          }
          return process.env.REPO_PATH;
        },
        triageComment: async (input) => {
          const {
            triagePrComment,
            makePrKey,
          } = await import("@codesteward/learning");
          // Cheap model from THIS org's matrix (BYOK + role overrides) — never a random host env model from another tenant
          let model: {
            complete: (req: {
              model?: string;
              messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
              temperature?: number;
              maxTokens?: number;
            }) => Promise<{ content?: string; text?: string }>;
            resolveCheapModel?: () => string | undefined;
          } | null = null;
          try {
            const { createOrgModelRouter, resolveOrgRoleModel } = await import(
              "./org-model-router.js"
            );
            const { router, config, fromOrgMatrix } = await createOrgModelRouter(input.orgId);
            const chat = router.createChatModel("summary" as never);
            const cheapName = resolveOrgRoleModel(config, "summary");
            if (fromOrgMatrix) {
              console.info(
                `[webhooks] comment triage model org=${input.orgId} role=summary model=${cheapName}`,
              );
            }
            model = {
              complete: async (req) => {
                const res = await chat.complete({
                  system: req.messages.find((m) => m.role === "system")?.content,
                  messages: req.messages
                    .filter((m) => m.role !== "system")
                    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
                  temperature: req.temperature,
                  maxTokens: req.maxTokens,
                });
                return { content: res.content, text: res.content };
              },
              resolveCheapModel: () => cheapName,
            };
          } catch (err) {
            console.warn(
              `[webhooks] org model for triage unavailable (org=${input.orgId}), heuristic only:`,
              err instanceof Error ? err.message : err,
            );
            model = null;
          }
          const triage = await triagePrComment(
            {
              commentBody: input.commentBody,
              repoId: input.repoId,
              prNumber: input.prNumber,
              author: input.author,
              prTitle: input.prTitle,
            },
            model,
          );
          if (triage.learning) {
            try {
              const L = triage.learning;
              await learningStore.addMemory({
                orgId: input.orgId,
                scope: L.scope,
                repoId: L.scope === "org" ? undefined : input.repoId,
                prKey:
                  L.scope === "pr"
                    ? makePrKey(input.repoId, input.prNumber)
                    : undefined,
                kind: L.kind ?? (L.polarity === "negative" ? "dismissal" : "preference"),
                polarity: L.polarity,
                title: L.title,
                body: L.body,
                source: `pr-comment:${input.author ?? "unknown"}`,
                weight: 1,
              });
            } catch (err) {
              console.warn(
                "[webhooks] failed to persist learning from comment:",
                err instanceof Error ? err.message : err,
              );
            }
          }
          return {
            intent: triage.intent,
            shouldReview: triage.intent === "review" || Boolean(triage.reviewFocus),
            reviewFocus: triage.reviewFocus,
            reply: triage.reply,
          };
        },
        enqueueGate: async ({ session, job }) => {
          let riskTier = session.riskTier;
          let depth = session.depth;
          // Webhook path must honor org plan (thorough = Pro+)
          if (riskTier === "thorough" || depth === "thorough") {
            try {
              const { requireOrgEntitled } = await import("./license.js");
              await requireOrgEntitled(String(session.orgId ?? "local"), "thoroughDiscourse");
            } catch {
              riskTier = "full";
              depth = depth === "thorough" ? "normal" : depth;
            }
          }
          // Persist session with fixed id
          const created = globalSessionStore.create({
            mode: "gate",
            repoId: session.repoId,
            tenantId: session.tenantId,
            orgId: session.orgId,
            repoPath: session.repoPath,
            baseSha: session.baseSha,
            headSha: session.headSha,
            baseBranch: session.baseBranch,
            headBranch: session.headBranch,
            prNumber: session.prNumber,
            scmProvider: "github",
            scmFullName: session.scmFullName,
            riskTier,
            depth,
            trigger: "webhook",
            paths: session.paths,
            metadata: {
              webhook: true,
              ...(session.metadata ?? {}),
              ...(riskTier !== session.riskTier
                ? { thoroughBlocked: true, thoroughBlockReason: "org_license_required" }
                : {}),
            },
          });
          // overwrite id if store generated different — use created.id
          const enqueued = await globalQueue.enqueue({
            ...job,
            sessionId: created.id,
            riskTier,
            depth,
          });
          return { sessionId: created.id, jobId: enqueued.id };
        },
      },
      headers,
      rawBody,
    );
    const { markDeliveryProcessed } = await import("./webhook-delivery.js");
    await markDeliveryProcessed(ghDeliveryId, {
      status: result.ok ? "processed" : "failed",
      error: result.ok ? undefined : JSON.stringify(result.body).slice(0, 500),
      sessionId: typeof result.body?.sessionId === "string" ? result.body.sessionId : undefined,
      jobId: typeof result.body?.jobId === "string" ? result.body.jobId : undefined,
    }).catch(() => undefined);
    return c.json(result.body, result.status as 200 | 202 | 400 | 401);
  });



  // GitLab webhooks (token or HMAC)
  app.post("/v1/webhooks/gitlab", async (c) => {
    const { handleGitLabWebhook } = await import("@codesteward/webhooks");
    const { GitLabScm } = await import("@codesteward/scm");
    const rawBody = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let glDeliveryId = String(
      headers["x-gitlab-event-uuid"] ??
        headers["X-Gitlab-Event-UUID"] ??
        headers["x-request-id"] ??
        `gl-${Date.now()}`,
    );
    {
      const { claimDelivery } = await import("./webhook-delivery.js");
      const claim = await claimDelivery({
        provider: "gitlab",
        deliveryId: glDeliveryId,
        event: headers["x-gitlab-event"] ?? headers["X-Gitlab-Event"],
        rawBody,
      });
      glDeliveryId = claim.deliveryId;
      if (claim.duplicate) {
        return c.json({ ok: true, duplicate: true, deliveryId: glDeliveryId }, 200);
      }
    }
    const scm = new GitLabScm();
    const result = await handleGitLabWebhook(
      {
        secret: process.env.GITLAB_WEBHOOK_SECRET ?? process.env.GITLAB_TOKEN ?? "dev-insecure",
        scm,
        resolveRepoPath: (owner, repo) => {
          const map = process.env.REPO_PATH_MAP;
          if (!map) return process.env.REPO_PATH;
          for (const part of map.split(",")) {
            const [key, path] = part.split(":");
            if (key === `${owner}/${repo}`) return path;
          }
          return process.env.REPO_PATH;
        },
        enqueueGate: async ({ session, job }) => {
          const created = globalSessionStore.create({
            mode: "gate",
            repoId: session.repoId,
            tenantId: session.tenantId,
            orgId: session.orgId,
            repoPath: session.repoPath,
            baseSha: session.baseSha,
            headSha: session.headSha,
            baseBranch: session.baseBranch,
            headBranch: session.headBranch,
            prNumber: session.prNumber,
            scmProvider: "gitlab",
            scmFullName: session.scmFullName,
            riskTier: session.riskTier,
            depth: session.depth,
            trigger: "webhook",
            paths: session.paths,
            metadata: { webhook: true, provider: "gitlab" },
          });
          const enqueued = await globalQueue.enqueue({
            ...job,
            sessionId: created.id,
          });
          return { sessionId: created.id, jobId: enqueued.id };
        },
      },
      headers,
      rawBody,
    );
    const { markDeliveryProcessed } = await import("./webhook-delivery.js");
    await markDeliveryProcessed(glDeliveryId, {
      status: result.ok ? "processed" : "failed",
      error: result.ok ? undefined : JSON.stringify(result.body).slice(0, 500),
    }).catch(() => undefined);
    return c.json(result.body, result.status as 200 | 202 | 400 | 401);
  });

  // SARIF export for a session
  app.get("/v1/sessions/:id/findings.sarif", async (c) => {
    const session = globalSessionStore.get(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const list = await findingsStore.list({
      sessionId: c.req.param("id"),
      orgId: session.orgId ?? c.get("orgId") ?? "local",
    });
    const sarif = findingsToSarif(list);
    return c.json(sarif);
  });

  // Finding reactions (👍 / 👎)
  app.post("/v1/findings/:id/react", async (c) => {
    const id = c.req.param("id");
    const finding = await findingsStore.get(id);
    if (!finding) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(finding.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    const body = (await c.req.json()) as {
      reaction: "up" | "down" | "👍" | "👎";
      note?: string;
      userId?: string;
    };
    if (!body.reaction) return c.json({ error: "reaction required" }, 400);
    const orgId = finding.orgId ?? c.get("orgId") ?? "local";
    const reaction = await learningStore.react({
      findingId: id,
      reaction: body.reaction,
      fingerprint: finding.fingerprint,
      orgId,
      repoId: finding.repoId,
      userId: body.userId,
      note: body.note ?? finding.title,
    });
    // Transition status on downvote + keep UI reaction tags in sync
    const isDown = body.reaction === "down" || body.reaction === "👎";
    const isUp = body.reaction === "up" || body.reaction === "👍";
    const tag = isDown ? "reaction:down" : isUp ? "reaction:up" : undefined;
    const cleaned = (finding.tags ?? []).filter((t) => !t.startsWith("reaction:"));
    const tags = tag ? [...cleaned, tag] : cleaned;
    if (isDown) {
      await findingsStore
        .update(id, { status: "false_positive", tags })
        .catch(() => findingsStore.transition(id, "false_positive").catch(() => undefined));
    } else {
      await findingsStore.update(id, { tags }).catch(() => undefined);
    }
    return c.json({ reaction, finding: await findingsStore.get(id) }, 201);
  });

  // Org / repo / PR memories (learnings)
  app.get("/v1/org/memories", async (c) => {
    const orgId = c.get("orgId") ?? c.req.query("orgId") ?? "local";
    const repoId = c.req.query("repoId") ?? undefined;
    const prKey = c.req.query("prKey") ?? undefined;
    const scope = c.req.query("scope") as "org" | "repo" | "pr" | undefined;
    const polarity = c.req.query("polarity") as "positive" | "negative" | undefined;
    const applicable = c.req.query("applicable") === "1" || c.req.query("applicable") === "true";
    const raw = await learningStore.listMemories({
      orgId,
      repoId,
      prKey,
      scope,
      polarity,
      applicable: applicable || undefined,
    });
    // Always surface scope for UI (legacy rows inferred from repoId/prKey)
    const memories = raw.map((m) => {
      const inferred =
        m.scope === "org" || m.scope === "repo" || m.scope === "pr"
          ? m.scope
          : m.prKey
            ? "pr"
            : m.repoId
              ? "repo"
              : "org";
      return { ...m, scope: inferred };
    });
    return c.json({ memories });
  });

  app.post("/v1/org/memories", async (c) => {
    const body = await c.req.json();
    try {
      const mem = await learningStore.addMemory({
        orgId: c.get("orgId") ?? "local",
        scope: body.scope,
        repoId: body.repoId,
        prKey: body.prKey,
        prNumber: body.prNumber,
        kind: body.kind ?? "preference",
        polarity: body.polarity ?? "negative",
        fingerprint: body.fingerprint,
        pattern: body.pattern,
        title: body.title,
        body: body.body,
        source: body.source ?? "api",
        weight: body.weight ?? 1,
      });
      return c.json({ memory: mem }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** Move a memory across org / repo / PR scopes. */
  app.patch("/v1/org/memories/:id/scope", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json()) as {
      scope?: "org" | "repo" | "pr";
      repoId?: string;
      prKey?: string;
      prNumber?: number;
    };
    if (!body.scope || !["org", "repo", "pr"].includes(body.scope)) {
      return c.json({ error: "scope must be org | repo | pr" }, 400);
    }
    const store = learningStore as {
      moveMemory?: (
        id: string,
        target: {
          scope: "org" | "repo" | "pr";
          repoId?: string;
          prKey?: string;
          prNumber?: number;
        },
      ) => Promise<unknown>;
    };
    if (typeof store.moveMemory !== "function") {
      return c.json({ error: "moveMemory not implemented on store" }, 501);
    }
    try {
      const memory = await store.moveMemory(id, {
        scope: body.scope,
        repoId: body.repoId,
        prKey: body.prKey,
        prNumber: body.prNumber,
      });
      if (!memory) return c.json({ error: "memory not found" }, 404);
      return c.json({ memory });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // Repo review state (last_reviewed_sha) — org-scoped
  app.get("/v1/repos/:repoId/review-state", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const state = await learningStore.getRepoState(c.req.param("repoId"), { orgId });
    return c.json({ state: state ?? null, orgId });
  });

  app.put("/v1/repos/:repoId/review-state", async (c) => {
    const body = await c.req.json();
    const orgId = c.get("orgId") ?? body.orgId ?? "local";
    const state = await learningStore.setRepoState({
      repoId: c.req.param("repoId"),
      orgId,
      lastReviewedSha: body.lastReviewedSha,
      lastSessionId: body.lastSessionId,
      lastPrNumber: body.lastPrNumber,
    });
    return c.json({ state });
  });

  // Jobs (debug + worker health for UI)
  app.get("/v1/jobs", async (c) => {
    const jobs = await globalQueue.list();
    const worker = getInlineWorkerStatus();
    // Recent claim activity (Postgres multi-worker) so UI can tell external workers are alive
    let lastExternalClaimAt: string | null = null;
    let runningLocked = 0;
    let pendingCount = 0;
    try {
      if (process.env.DATABASE_URL?.trim()) {
        const { createStewardDb } = await import("@codesteward/db");
        const db = createStewardDb();
        const res = await db.pool.query<{
          locked_at: Date | null;
          status: string;
          n: string;
        }>(
          `SELECT status, max(locked_at) AS locked_at, count(*)::text AS n
           FROM jobs
           WHERE status IN ('pending', 'running')
              OR (locked_at IS NOT NULL AND locked_at > now() - interval '15 minutes')
           GROUP BY status`,
        );
        for (const row of res.rows) {
          if (row.status === "pending") pendingCount = Number(row.n) || 0;
          if (row.status === "running") runningLocked = Number(row.n) || 0;
          if (row.locked_at) {
            const iso = new Date(row.locked_at).toISOString();
            if (!lastExternalClaimAt || iso > lastExternalClaimAt) {
              lastExternalClaimAt = iso;
            }
          }
        }
      }
    } catch {
      /* best-effort */
    }
    const externalActive =
      worker.mode === "external" &&
      (Boolean(lastExternalClaimAt) || runningLocked > 0 || pendingCount === 0);
    return c.json({
      jobs,
      worker: {
        ...worker,
        lastExternalClaimAt,
        pendingCount,
        runningCount: runningLocked,
        /** UI: true when something will drain the queue */
        healthy:
          worker.mode === "inline"
            ? Boolean(worker.running)
            : externalActive || pendingCount === 0,
      },
      message:
        worker.mode === "inline"
          ? worker.hint
          : externalActive || pendingCount === 0
            ? worker.hint
            : "Jobs are pending but no worker claim seen — ensure category worker container is up (docker compose … worker) or set STEW_INLINE_WORKER=1 for single-process mode.",
    });
  });

  // SSE progress
  app.get("/v1/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const session = globalSessionStore.get(id);
    if (!session) return c.json({ error: "not found" }, 404);
    try {
      requireOrgMatch(session.orgId, c.get("orgId") ?? "local", c.get("authMode") as string);
    } catch {
      return c.json(orgForbidden(), 403);
    }
    // Allow EventSource auth via ?access_token= when browsers cannot set Authorization
    const qToken = c.req.query("access_token");
    if (qToken && !c.get("user")) {
      /* middleware may have already auth'd; token query is fallback validated in middleware if present */
    }

    return streamSSE(c, async (stream) => {
      // Multi-process: worker appends session_events in Postgres; API polls them.
      // Also subscribe in-process for same-process emits (inline worker / tests).
      // Last-Event-ID: EventSource auto-reconnect must not re-play full backlog.
      let closed = false;
      const lastHeader = c.req.header("Last-Event-ID") ?? c.req.query("after") ?? "0";
      let lastEventId = Number.parseInt(lastHeader, 10);
      if (!Number.isFinite(lastEventId) || lastEventId < 0) lastEventId = 0;
      const seenKeys = new Set<string>();

      const writeEv = async (ev: ProgressEvent, durableId?: number) => {
        if (closed) return;
        const key =
          durableId != null
            ? `id:${durableId}`
            : `${ev.type}:${ev.ts}:${"unitId" in ev ? String((ev as { unitId?: string }).unitId ?? "") : ""}:${"message" in ev ? String((ev as { message?: string }).message ?? "").slice(0, 80) : ""}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        await stream.writeSSE({
          data: JSON.stringify(ev),
          event: ev.type,
          ...(durableId != null ? { id: String(durableId) } : {}),
        });
        if (ev.type === "completed" || (ev.type === "error" && !(ev as { retriable?: boolean }).retriable)) {
          closed = true;
        }
      };

      // Catch-up from durable store (respect Last-Event-ID on reconnect)
      try {
        const backlog = await globalSessionStore.listEventsSince(id, lastEventId);
        for (const row of backlog) {
          lastEventId = Math.max(lastEventId, row.id);
          await writeEv(row.event, row.id);
        }
      } catch {
        if (lastEventId === 0) {
          for (const ev of globalSessionStore.getEvents(id)) {
            await writeEv(ev);
          }
        }
      }

      const unsub = globalSessionStore.subscribe(id, (ev) => {
        void writeEv(ev);
      });

      const pollMs = Number(process.env.STEW_SSE_POLL_MS ?? 1000);
      const deadline = Date.now() + 300_000;
      while (!closed && Date.now() < deadline) {
        try {
          const batch = await globalSessionStore.listEventsSince(id, lastEventId);
          for (const row of batch) {
            lastEventId = Math.max(lastEventId, row.id);
            await writeEv(row.event, row.id);
          }
        } catch {
          /* keep stream open */
        }
        if (closed) break;
        await stream.sleep(pollMs);
      }
      closed = true;
      unsub();
    });
  });

  // Also expose findings store for worker process sharing via same file path
  void loadEnvSafe;
  void findingsStore;


  // ── OIDC (Keycloak / any OIDC IdP) ─────────────────────────────────
  app.get("/v1/auth/oidc/status", async (c) => {
    const { getOidcStatus } = await import("./auth/oidc.js");
    return c.json(await getOidcStatus());
  });

  app.get("/v1/auth/oidc/login", async (c) => {
    try {
      const { requireEntitled } = await import("./license.js");
      try {
        requireEntitled("sso");
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 402) {
          return c.json(
            {
              error: e.message,
              code: "LICENSE_REQUIRED",
              feature: "sso",
              hint: "Upgrade STEW_LICENSE_TIER to pro/enterprise or set a signed license with sso:true",
            },
            402,
          );
        }
        throw err;
      }
      const { buildAuthorizationUrl } = await import("./auth/oidc.js");
      const returnTo = c.req.query("returnTo") ?? undefined;
      const { url, state } = await buildAuthorizationUrl({ returnTo });
      if (c.req.query("redirect") === "1") {
        return c.redirect(url);
      }
      return c.json({ url, state });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.get("/v1/auth/oidc/callback", async (c) => {
    const uiBase = (process.env.STEW_PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, "");
    /**
     * OIDC redirect_uri is the API (PKCE verifier lives server-side). After exchange
     * we always 302 the *browser* to the UI — never leave the user on :8081 JSON.
     * Explicit Accept: application/json keeps machine-readable responses for tests/tools.
     */
    const wantsJson =
      c.req.query("format") === "json" ||
      ((c.req.header("accept") ?? "").includes("application/json") &&
        !(c.req.header("accept") ?? "").includes("text/html"));

    const redirectUiError = (message: string, code?: string) => {
      const q = new URLSearchParams({ error: message });
      if (code) q.set("code", code);
      return c.redirect(`${uiBase}/login?${q.toString()}`);
    };

    try {
      const { requireEntitled } = await import("./license.js");
      try {
        requireEntitled("sso");
      } catch (err) {
        const e = err as Error & { status?: number };
        if (e.status === 402) {
          if (wantsJson) return c.json({ error: e.message, code: "LICENSE_REQUIRED" }, 402);
          return redirectUiError(e.message, "LICENSE_REQUIRED");
        }
        throw err;
      }
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) {
        if (wantsJson) return c.json({ error: "code and state required" }, 400);
        return redirectUiError("Sign-in incomplete (missing code or state). Try again.");
      }
      const { exchangeCode, safeReturnTo, storeOidcIdTokenForSession } = await import(
        "./auth/oidc.js"
      );
      const { claims, returnTo, idToken } = await exchangeCode(code, state);
      // Keycloak SoT: map orgs/roles from claims → local shadow for product FKs
      const { syncOidcLogin } = await import("./identity/sync.js");
      const result = await syncOidcLogin(claims);
      const token = result.token;
      // Keep id_token for RP-initiated logout (ends Keycloak SSO cookie)
      if (idToken) storeOidcIdTokenForSession(token, idToken);
      const rt = safeReturnTo(returnTo);
      if (wantsJson) {
        return c.json({
          ok: true,
          user: result.user,
          token: result.token,
          idToken,
          created: result.created,
          orgs: result.orgs,
          primaryOrgId: result.primaryOrgId,
          returnTo,
        });
      }
      // Fragment keeps tokens out of server access logs / Referer on next navigation
      const frag = new URLSearchParams({
        oidc_token: token,
        returnTo: rt,
        orgId: result.primaryOrgId,
      });
      if (idToken) frag.set("id_token", idToken);
      const dest = `${uiBase}/login#${frag.toString()}`;
      return c.redirect(dest);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (wantsJson) return c.json({ error: e.message }, (e.status ?? 400) as 400 | 401);
      return redirectUiError(e.message || "Sign-in failed");
    }
  });

  /** Identity mode + Keycloak Admin health (for UI / ops). */
  app.get("/v1/identity/status", async (c) => {
    const { getIdentityMode, isKeycloakIdentityMode } = await import("./identity/mode.js");
    const { isKeycloakAdminConfigured, healthCheck } = await import(
      "./identity/keycloak-admin.js"
    );
    const { getOidcStatus } = await import("./auth/oidc.js");
    const mode = getIdentityMode();
    const oidc = await getOidcStatus();
    let admin: { ok: boolean; realm?: string; error?: string } | null = null;
    if (isKeycloakIdentityMode() && isKeycloakAdminConfigured()) {
      admin = await healthCheck();
    }
    return c.json({
      mode,
      keycloak: isKeycloakIdentityMode(),
      oidc,
      adminConfigured: isKeycloakAdminConfigured(),
      admin,
      note:
        mode === "keycloak"
          ? "Managed identity mode: the platform IdP owns users/orgs/roles. App login redirects there by default. Federated SSO (Entra, Google, Okta, …) and MFA are configured on the IdP — not in Codesteward."
          : "Local identity mode — users stored in Codesteward. Set STEW_IDENTITY_MODE=keycloak for managed platform IdP as identity SoT.",
    });
  });

  /**
   * User admin — always scoped to the active org (membership-bound c.get("orgId")).
   * Never list/mutate another tenant's directory. X-Org-Id only selects which org
   * after assertMembership; it is not a trust boundary by itself.
   */
  app.get("/v1/auth/users", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const members = await getTenancyStore().listMembers(orgId);
    const memberIds = new Set(members.map((m) => m.userId));
    const roleByUser = new Map(members.map((m) => [m.userId, m.role]));
    // Only return users who are members of the active org (not install-wide directory)
    const all = await globalAuthStore.listUsers();
    const users = all
      .filter((u) => memberIds.has(u.id) || u.orgId === orgId)
      .map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        /** Org membership role when present; else home-org product role */
        role: (roleByUser.get(u.id) as string | undefined) ?? u.role,
        orgId,
        createdAt: u.createdAt,
      }));
    return c.json({ orgId, users });
  });

  app.post("/v1/auth/users", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    // Ignore body.orgId — never allow client to provision into another tenant
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json()) as {
      email?: string;
      password?: string;
      displayName?: string;
      role?: "admin" | "reviewer" | "viewer";
      orgId?: string;
    };
    if (!body.email || !body.password) {
      return c.json({ error: "email and password required" }, 400);
    }
    if (body.orgId && body.orgId !== orgId) {
      return c.json(
        {
          error: "forbidden",
          message: "Cannot create users in another organization; X-Org-Id / membership selects org",
        },
        403,
      );
    }
    try {
      const orgRole =
        body.role === "admin" ? "admin" : body.role === "viewer" ? "viewer" : "reviewer";
      // Keycloak identity mode: create in Keycloak first (SoT), then local shadow
      try {
        const { isKeycloakIdentityMode } = await import("./identity/mode.js");
        const { isKeycloakAdminConfigured, provisionMember } = await import(
          "./identity/keycloak-admin.js"
        );
        if (isKeycloakIdentityMode() && isKeycloakAdminConfigured()) {
          const { getTenancyStore } = await import("./tenancy/orgs.js");
          const org = await getTenancyStore().getOrg(orgId);
          const slug = org?.slug || orgId;
          await provisionMember({
            email: body.email,
            password: body.password,
            displayName: body.displayName,
            orgSlug: slug,
            role: orgRole,
            temporaryPassword: false,
          });
        }
      } catch (err) {
        console.warn("[auth] keycloak provision on createUser", err);
        // continue with local create so self-host still works if Admin API not ready
      }
      const existing = await globalAuthStore.getUserByEmail(body.email);
      let user =
        existing != null
          ? await globalAuthStore.updateUser(existing.id, {
              displayName: body.displayName,
              role: body.role ?? "reviewer",
              orgId,
            })
          : await globalAuthStore.createUser({
              email: body.email,
              password: body.password,
              displayName: body.displayName,
              role: body.role ?? "reviewer",
              orgId,
            });
      if (!user) {
        return c.json({ error: "failed to create user" }, 500);
      }
      const { getTenancyStore } = await import("./tenancy/orgs.js");
      await getTenancyStore().upsertMember({
        orgId,
        userId: user.id,
        role: orgRole,
      });
      try {
        const { auditLog, auditContextFromRequest } = await import("./audit.js");
        await auditLog({
          action: "users.create",
          ...auditContextFromRequest(c),
          resourceType: "user",
          resourceId: user.id,
          metadata: { email: user.email, role: user.role, orgId },
        });
      } catch {
        /* optional */
      }
      return c.json({ user: { ...user, orgId } }, existing ? 200 : 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.patch("/v1/auth/users/:id", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    const targetId = c.req.param("id");
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const store = getTenancyStore();
    const membership = await store.getMembership(orgId, targetId);
    const target = await globalAuthStore.getUserById(targetId);
    if (!target || (!membership && target.orgId !== orgId)) {
      // Same 404 whether missing or other-tenant — no existence leak across orgs
      return c.json({ error: "not found" }, 404);
    }
    const body = (await c.req.json()) as {
      role?: "admin" | "reviewer" | "viewer";
      displayName?: string;
      active?: boolean;
    };
    const user = await globalAuthStore.updateUser(targetId, body);
    if (!user) return c.json({ error: "not found" }, 404);
    // Keep org membership RBAC in sync when role changes
    if (body.role) {
      await store.upsertMember({
        orgId,
        userId: targetId,
        role: body.role === "admin" ? "admin" : body.role === "viewer" ? "viewer" : "reviewer",
      });
    }
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "users.update",
        ...auditContextFromRequest(c),
        resourceType: "user",
        resourceId: user.id,
        metadata: { patch: Object.keys(body), orgId },
      });
    } catch {
      /* optional */
    }
    return c.json({ user: { ...user, orgId } });
  });

  /**
   * Per-tenant Langfuse (optional). Can be set together with platform Langfuse —
   * when both have keys, reviews dual-write to both projects.
   */
  app.get("/v1/org/langfuse", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const { isEntitled } = await import("./license.js");
    const {
      getOrgSettingsStore,
      maskLangfuse,
      loadLangfuseDestinationsForRuntime,
    } = await import("./org-settings-store.js");
    const doc = await getOrgSettingsStore().get(orgId);
    const masked = maskLangfuse(doc.langfuse);
    const destinations = isEntitled("langfuse")
      ? await loadLangfuseDestinationsForRuntime(orgId)
      : [];
    return c.json({
      orgId,
      entitled: isEntitled("langfuse"),
      config: masked,
      destinations: destinations.map((d) => ({
        source: d.source,
        baseUrl: d.baseUrl,
        publicKeyHint:
          d.publicKey.length > 8
            ? `${d.publicKey.slice(0, 4)}…${d.publicKey.slice(-4)}`
            : "••••",
      })),
      dualWrite: destinations.length > 1,
      note:
        "Optional org Langfuse project. If platform Langfuse is also configured, traces are dual-written to both. Disable only turns off this org project (platform still receives if set).",
    });
  });

  app.put("/v1/org/langfuse", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      publicKey?: string;
      secretKey?: string;
      baseUrl?: string;
      clear?: boolean;
    };
    const { getOrgSettingsStore, maskLangfuse } = await import("./org-settings-store.js");
    const saved = await getOrgSettingsStore().putLangfuse(orgId, body.clear ? null : body);
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "langfuse.org.update",
        ...auditContextFromRequest(c),
        resourceType: "langfuse",
        metadata: {
          enabled: saved.langfuse?.enabled !== false,
          publicKeySet: Boolean(saved.langfuse?.publicKey),
          clear: Boolean(body.clear),
        },
      });
    } catch {
      /* optional */
    }
    return c.json({
      ok: true,
      orgId,
      config: maskLangfuse(saved.langfuse),
    });
  });

  /**
   * Install-wide GitHub App — optional enforce so all tenants share one App.
   * Orgs only attach installation IDs; they cannot upload PEMs/PATs when enforce=true.
   */
  app.get("/v1/platform/github-app", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    const {
      getPlatformGithubApp,
      maskPlatformGithubApp,
      resolvePlatformGithubAppPolicy,
    } = await import("./platform-github-app-store.js");
    const stored = await getPlatformGithubApp();
    const policy = await resolvePlatformGithubAppPolicy();
    return c.json({
      config: maskPlatformGithubApp(stored),
      policy: {
        enforce: policy.enforce,
        allowOrgPat: policy.allowOrgPat,
        configured: policy.configured,
        source: policy.source,
        appId: policy.appId ?? null,
        slug: policy.slug ?? null,
      },
      envBootstrap: {
        STEW_PLATFORM_GITHUB_APP_ENFORCE: process.env.STEW_PLATFORM_GITHUB_APP_ENFORCE ?? null,
        GITHUB_APP_ID: process.env.GITHUB_APP_ID ? "set" : null,
        GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG ?? null,
      },
      note:
        "When enforce is on, every org must install this shared GitHub App. Tenants cannot paste their own App PEM or (by default) a PAT.",
    });
  });

  app.put("/v1/platform/github-app", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enforce?: boolean;
      allowOrgPat?: boolean;
      appId?: string;
      clientId?: string;
      privateKeyPem?: string;
      privateKeyRef?: string;
      webhookSecret?: string;
      baseUrl?: string;
      slug?: string;
      clear?: boolean;
    };
    const { putPlatformGithubApp, maskPlatformGithubApp } = await import(
      "./platform-github-app-store.js"
    );
    if (body.enforce && !body.clear) {
      const hasCreds = Boolean(
        (body.appId || body.privateKeyPem || body.privateKeyRef) ||
          process.env.GITHUB_APP_ID,
      );
      // Allow enabling enforce when store already has appId from previous save
      const prev = await import("./platform-github-app-store.js").then((m) =>
        m.getPlatformGithubApp(),
      );
      if (!hasCreds && !prev?.appId && !prev?.privateKeyPem && !prev?.privateKeyRef) {
        return c.json(
          {
            error:
              "Provide appId + privateKeyPem (or privateKeyRef) before enabling enforce, or set GITHUB_APP_* env.",
          },
          400,
        );
      }
    }
    const saved = await putPlatformGithubApp(body.clear ? { clear: true } : body);
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "github_app.platform.update",
        ...auditContextFromRequest(c),
        resourceType: "github_app",
        resourceId: "platform",
        metadata: {
          enforce: saved?.enforce,
          allowOrgPat: saved?.allowOrgPat,
          appId: saved?.appId,
          clear: Boolean(body.clear),
        },
      });
    } catch {
      /* optional */
    }
    return c.json({
      ok: true,
      config: maskPlatformGithubApp(saved),
      note: saved?.enforce
        ? "Platform GitHub App enforced — tenants can only install this App on their GitHub orgs."
        : "Platform GitHub App saved (not enforced).",
    });
  });

  /** Install-wide Langfuse project (platform operator). Optional; dual-writes with org when both set. */
  app.get("/v1/platform/langfuse", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    const { isEntitled } = await import("./license.js");
    const {
      getPlatformLangfuse,
      maskLangfuse,
      loadPlatformLangfuseForRuntime,
    } = await import("./platform-langfuse-store.js");
    const stored = await getPlatformLangfuse();
    const effective = isEntitled("langfuse")
      ? await loadPlatformLangfuseForRuntime()
      : null;
    return c.json({
      entitled: isEntitled("langfuse"),
      config: maskLangfuse(stored),
      effective: effective
        ? {
            source: effective.source,
            baseUrl: effective.baseUrl,
            publicKeyHint:
              effective.publicKey.length > 8
                ? `${effective.publicKey.slice(0, 4)}…${effective.publicKey.slice(-4)}`
                : "••••",
          }
        : null,
      envFallback: Boolean(
        process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
      ),
      note:
        "Optional install-wide Langfuse project. When an org also has keys, each review dual-writes to platform + org. Env LANGFUSE_* is used if this form is empty.",
    });
  });

  app.put("/v1/platform/langfuse", async (c) => {
    const authMode = c.get("authMode") as string | undefined;
    const user = c.get("user") as import("./auth-store.js").PublicAuthUser | undefined;
    try {
      const { requirePlatformAdmin } = await import("./platform-admin.js");
      requirePlatformAdmin(user ?? null, authMode);
    } catch (err) {
      const e = err as Error & { status?: number };
      return c.json({ error: "forbidden", message: e.message }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      publicKey?: string;
      secretKey?: string;
      baseUrl?: string;
      clear?: boolean;
    };
    const { putPlatformLangfuse, maskLangfuse } = await import(
      "./platform-langfuse-store.js"
    );
    const saved = await putPlatformLangfuse(body.clear ? null : body);
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "langfuse.platform.update",
        ...auditContextFromRequest(c),
        resourceType: "langfuse",
        resourceId: "platform",
        metadata: {
          enabled: saved?.enabled !== false,
          publicKeySet: Boolean(saved?.publicKey),
          clear: Boolean(body.clear),
        },
      });
    } catch {
      /* optional */
    }
    return c.json({ ok: true, config: maskLangfuse(saved) });
  });

  /**
   * SCIM multi-tenant status for the active org.
   * Canonical IdP base: /scim/v2/orgs/{orgId|slug} — path scopes tenant on a shared domain.
   */
  app.get("/v1/org/scim", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const { isOrgEntitled } = await import("./license.js");
    const { getTenancyStore } = await import("./tenancy/orgs.js");
    const { orgScimBaseUrl, publicApiBase } = await import("./scim/tenant.js");
    const { listScimTokens, orgHasScimToken } = await import("./scim/tokens-store.js");
    // Org plan (SaaS billing / license) — not process-wide open mode
    const entitled =
      process.env.STEW_SCIM_ALLOW_WITHOUT_LICENSE === "1" ||
      (await isOrgEntitled(String(orgId), "scim"));
    const org = (await getTenancyStore().getOrg(orgId)) ?? {
      id: orgId,
      slug: orgId,
      name: orgId,
      tenantId: "local",
      createdAt: new Date().toISOString(),
    };
    const baseUrl = orgScimBaseUrl(org);
    const tokens = await listScimTokens(orgId);
    const activeTokens = tokens.filter((t) => !t.revokedAt);
    const tokenConfigured = await orgHasScimToken(orgId);
    return c.json({
      orgId: org.id,
      orgSlug: org.slug,
      multiTenant: true,
      entitled,
      planRequired: entitled ? null : "enterprise",
      tokenConfigured,
      tokens: activeTokens.map((t) => ({
        id: t.id,
        label: t.label,
        last4: t.last4,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      })),
      hardDelete: process.env.STEW_SCIM_HARD_DELETE === "1",
      /** What to paste into Okta/Entra SCIM connector (tenant-scoped) */
      baseUrl,
      endpoints: {
        ServiceProviderConfig: `${baseUrl}/ServiceProviderConfig`,
        Users: `${baseUrl}/Users`,
        Groups: `${baseUrl}/Groups`,
      },
      legacyUnscopedBase: `${publicApiBase()}/scim/v2`,
      auth: {
        header: "Authorization: Bearer <org-scim-token>",
        note:
          "Mint a per-org token in Organization settings (full secret shown once; later only last-4). Use the tenant base URL /scim/v2/orgs/{org}. Do not use a shared STEW_SCIM_TOKEN for multi-tenant installs.",
      },
      roleGroups: [
        "Admin / Admins → product role admin",
        "Reviewers / Members → reviewer",
        "Viewers → viewer",
      ],
    });
  });

  /** Mint a per-org SCIM bearer token (admin). Plaintext shown once. */
  app.post("/v1/org/scim/tokens", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    // Always org-scoped (SaaS Free/Pro must not mint). Escape hatch: STEW_SCIM_ALLOW_WITHOUT_LICENSE=1
    if (process.env.STEW_SCIM_ALLOW_WITHOUT_LICENSE !== "1") {
      try {
        const { requireOrgEntitled } = await import("./license.js");
        await requireOrgEntitled(String(orgId), "scim");
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        if (e.status === 402) {
          return c.json(
            {
              error: e.message,
              message: e.message,
              code: e.code ?? "ORG_LICENSE_REQUIRED",
              feature: "scim",
            },
            402,
          );
        }
        throw err;
      }
    }
    const body = (await c.req.json().catch(() => ({}))) as { label?: string };
    const { mintScimToken } = await import("./scim/tokens-store.js");
    const { token, meta } = await mintScimToken({
      orgId,
      label: body.label,
      createdBy: (c.get("user") as { id?: string } | undefined)?.id,
    });
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "scim.token.mint",
        ...auditContextFromRequest(c),
        resourceType: "scim_token",
        resourceId: meta.id,
        metadata: { last4: meta.last4, label: meta.label },
      });
    } catch {
      /* optional */
    }
    return c.json(
      {
        ok: true,
        token,
        meta: {
          id: meta.id,
          orgId: meta.orgId,
          label: meta.label,
          last4: meta.last4,
          createdAt: meta.createdAt,
        },
        warning: "Store this token now — it will not be shown again.",
      },
      201,
    );
  });

  app.delete("/v1/org/scim/tokens/:id", async (c) => {
    const role = c.get("role");
    if (role !== "admin" && c.get("authMode") !== "api_key" && c.get("authMode") !== "dev_open") {
      return c.json({ error: "forbidden", message: "admin role required" }, 403);
    }
    const orgId = c.get("orgId") ?? "local";
    const { revokeScimToken } = await import("./scim/tokens-store.js");
    const ok = await revokeScimToken(orgId, c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    try {
      const { auditLog, auditContextFromRequest } = await import("./audit.js");
      await auditLog({
        action: "scim.token.revoke",
        ...auditContextFromRequest(c),
        resourceType: "scim_token",
        resourceId: c.req.param("id"),
      });
    } catch {
      /* optional */
    }
    return c.json({ ok: true, revoked: true });
  });

  // Quality KPIs — fix/accept vs noise (not FP-inflated "address rate")
  app.get("/v1/analytics/address-rate", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "analytics");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const findings = await findingsStore.list({ orgId });
    const sessions = globalSessionStore.list({ orgId });
    const floor = c.req.query("minSeverity"); // optional
    const windowDays = Number(c.req.query("windowDays") ?? 14);
    const sevRank: Record<string, number> = {
      critical: 5,
      high: 4,
      medium: 3,
      low: 2,
      nit: 1,
      info: 0,
    };
    const minRank = floor ? (sevRank[floor] ?? 0) : 0;
    const considered = findings.filter(
      (f) => (sevRank[f.severity] ?? 0) >= minRank,
    );
    const { computeQualityKpis, createOutcomeStore } = await import("@codesteward/learning");
    let outcomes: Awaited<ReturnType<ReturnType<typeof createOutcomeStore>["listFindingOutcomes"]>> =
      [];
    try {
      outcomes = await createOutcomeStore().listFindingOutcomes({
        orgId: String(orgId),
        limit: 2000,
      });
    } catch {
      /* optional */
    }
    const kpis = computeQualityKpis({
      findings: considered.map((f) => ({
        id: f.id,
        repoId: f.repoId,
        title: f.title,
        fingerprint: f.fingerprint,
        status: f.status,
        tags: f.tags,
        severity: f.severity,
        confidence: f.confidence,
        path: f.path,
      })),
      outcomes,
      windowDays,
    });
    // Legacy "addressed" kept for UI compatibility but split fields are preferred
    const addressedLegacy = considered.filter(
      (f) =>
        ["fixed", "wontfix", "false_positive"].includes(f.status) ||
        (f.tags ?? []).some((t) => t === "reaction:up"),
    );
    const weeks: number[] = [0, 0, 0, 0, 0, 0, 0];
    const now = Date.now();
    for (const f of considered.filter(
      (x) =>
        x.status === "fixed" ||
        (x.tags ?? []).includes("reaction:up") ||
        (x.tags ?? []).some((t) => t.startsWith("auto-fixed:")),
    )) {
      const ts = new Date(f.updatedAt ?? f.createdAt ?? now).getTime();
      const days = Math.min(6, Math.max(0, Math.floor((now - ts) / 86400000)));
      const idx = 6 - days;
      weeks[idx] = (weeks[idx] ?? 0) + 1;
    }
    const fixAcceptRatePct =
      kpis.fixAcceptRate == null
        ? null
        : Math.round(kpis.fixAcceptRate * 1000) / 10;
    return c.json({
      orgId,
      /** North-star: fixed|auto-fixed|thumbs_up (does NOT include FP/wontfix) */
      addressRate: fixAcceptRatePct,
      fixAcceptRate: fixAcceptRatePct,
      noiseRate:
        kpis.noiseRate == null ? null : Math.round(kpis.noiseRate * 1000) / 10,
      openRate:
        kpis.openRate == null ? null : Math.round(kpis.openRate * 1000) / 10,
      considered: kpis.considered,
      fixAccept: kpis.fixAccept,
      noise: kpis.noise,
      addressed: kpis.fixAccept,
      dismissed: kpis.noise,
      open: kpis.open,
      /** @deprecated mixed legacy count — prefer fixAccept + noise */
      addressedLegacy: addressedLegacy.length,
      sessions: sessions.length,
      completedSessions: sessions.filter((s) => s.status === "completed").length,
      weekBuckets: weeks,
      confidenceCalibration: kpis.confidenceCalibration,
      windowDays,
      empty: considered.length === 0,
      definition: kpis.definition,
    });
  });

  /** Merge-time PR outcomes + gate regret summary */
  app.get("/v1/analytics/outcomes", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "analytics");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const { createOutcomeStore } = await import("@codesteward/learning");
    const store = createOutcomeStore();
    const limit = Number(c.req.query("limit") ?? 50);
    const prOutcomes = await store.listPrOutcomes({ orgId: String(orgId), limit });
    const findingOutcomes = await store.listFindingOutcomes({
      orgId: String(orgId),
      limit: 500,
    });
    const gateRegretMiss = findingOutcomes.filter((o) => o.kind === "gate_regret_miss").length;
    const gateRegretNoise = findingOutcomes.filter((o) => o.kind === "gate_regret_noise").length;
    const agentMiss = findingOutcomes.filter((o) => o.kind === "agent_miss_candidate").length;
    const ignoreAtMerge = findingOutcomes.filter((o) => o.kind === "unaddressed_at_merge").length;
    return c.json({
      orgId,
      prOutcomes,
      summary: {
        prs: prOutcomes.length,
        gateRegretMiss,
        gateRegretNoise,
        agentMissCandidates: agentMiss,
        unaddressedAtMerge: ignoreAtMerge,
      },
    });
  });

  /**
   * Promote outcome history → memories with correct scope:
   * repo-only patterns → repo; multi-repo or important → org.
   */
  app.post("/v1/analytics/outcomes/consolidate", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "analytics");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      windowDays?: number;
      minRepoCount?: number;
      minOrgRepos?: number;
      minOrgCount?: number;
      minImportantCount?: number;
    };
    const { createOutcomeStore, consolidateOutcomeMemories } = await import(
      "@codesteward/learning"
    );
    const result = await consolidateOutcomeMemories(
      createOutcomeStore(),
      learningStore,
      {
        orgId: String(orgId),
        windowDays: body.windowDays,
        minRepoCount: body.minRepoCount,
        minOrgRepos: body.minOrgRepos,
        minOrgCount: body.minOrgCount,
        minImportantCount: body.minImportantCount,
      },
    );
    return c.json({
      ok: true,
      ...result,
      // Don't dump full planned bodies by default in huge orgs — include summary
      plannedSummary: result.planned.map((p) => ({
        key: p.key,
        scope: p.scope,
        repoId: p.repoId,
        polarity: p.polarity,
        weight: p.weight,
        reason: p.evidence.reason,
        total: p.evidence.total,
        repos: p.evidence.repos,
      })),
    });
  });

  /** Export outcome-derived eval fixtures (production → offline harness) */
  app.get("/v1/analytics/outcomes/eval-export", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    try {
      const { requireOrgEntitled } = await import("./license.js");
      await requireOrgEntitled(String(orgId), "analytics");
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      if (e.status === 402) {
        return c.json({ error: e.message, code: e.code ?? "ORG_LICENSE_REQUIRED" }, 402);
      }
      throw err;
    }
    const { createOutcomeStore, outcomesToEvalCases } = await import(
      "@codesteward/learning"
    );
    const store = createOutcomeStore();
    const outcomes = await store.listFindingOutcomes({
      orgId: String(orgId),
      limit: Number(c.req.query("limit") ?? 1000),
    });
    const findings = await findingsStore.list({ orgId: String(orgId) });
    const byId = new Map(findings.map((f) => [f.id, f]));
    const cases = outcomesToEvalCases(
      outcomes,
      byId as Map<
        string,
        {
          id: string;
          path?: string;
          title: string;
          severity?: string;
          confidence?: number;
          repoId: string;
          fingerprint: string;
          status: string;
        }
      >,
    );
    return c.json({
      orgId,
      generatedAt: new Date().toISOString(),
      cases,
      n: cases.length,
    });
  });

  // Durable org policy (file-backed) — kills localStorage-only product path
  app.get("/v1/org/policy", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
    const file = join(dir, `policy-${orgId}.md`);
    try {
      const content = await readFile(file, "utf8");
      return c.json({ orgId, content, source: "org_store" });
    } catch {
      return c.json({
        orgId,
        content: "",
        source: "empty",
        note: "Policy also loads STEWARD.md from base branch at review time",
      });
    }
  });

  app.put("/v1/org/policy", async (c) => {
    const orgId = c.get("orgId") ?? "local";
    const body = (await c.req.json()) as { content?: string };
    if (typeof body.content !== "string") {
      return c.json({ error: "content string required" }, 400);
    }
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
    const file = join(dir, `policy-${orgId}.md`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body.content, "utf8");
    return c.json({ ok: true, orgId, bytes: body.content.length });
  });

  app.delete("/v1/org/memories/:id", async (c) => {
    const id = c.req.param("id");
    const store = learningStore as { deleteMemory?: (id: string) => Promise<boolean> };
    if (typeof store.deleteMemory === "function") {
      const ok = await store.deleteMemory(id);
      if (!ok) return c.json({ deleted: false, error: "memory not found" }, 404);
      return c.json({ deleted: true });
    }
    return c.json({ deleted: false, message: "deleteMemory not implemented on store" }, 501);
  });

  registerExtraRoutes(app, { findingsStore, globalSessionStore, globalQueue });
  registerTenancyRoutes(app);
  // SCIM 2.0 directory provisioning (enterprise; own bearer auth)
  registerScimRoutes(app);
  return app;
}

export { globalSessionStore, globalQueue, findingsStore, learningStore };
