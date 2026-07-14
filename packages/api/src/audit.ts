/**
 * Durable admin / IAM audit trail (SIEM-oriented).
 *
 * Storage: Postgres `audit_events` when DATABASE_URL set; else append-only
 * `.steward-data/audit.jsonl`. Events are insert-only (no update/delete API).
 *
 * Retention: STEW_AUDIT_RETENTION_DAYS (default 365). Call pruneAuditEvents
 * periodically or via GET/POST /v1/org/audit/prune (admin).
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface AuditEvent {
  id: string;
  action: string;
  orgId?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** Client IP when available */
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** success | failure | denied */
  outcome?: string;
  createdAt: string;
}

export type AuditLogInput = {
  action: string;
  orgId?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  outcome?: "success" | "failure" | "denied" | string;
};

export async function auditLog(event: AuditLogInput): Promise<void> {
  const row: AuditEvent = {
    id: `aud_${randomBytes(6).toString("hex")}`,
    action: event.action,
    orgId: event.orgId,
    actorUserId: event.actorUserId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    metadata: event.metadata ?? {},
    ip: event.ip,
    userAgent: event.userAgent,
    requestId: event.requestId,
    outcome: event.outcome ?? "success",
    createdAt: new Date().toISOString(),
  };
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.pool) {
        await db.pool.query(
          `INSERT INTO audit_events
             (id, tenant_id, org_id, actor_user_id, action, resource_type, resource_id,
              metadata, ip, user_agent, request_id, outcome, created_at)
           VALUES ($1,'local',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,now())`,
          [
            row.id,
            event.orgId ?? null,
            event.actorUserId ?? null,
            event.action,
            event.resourceType ?? null,
            event.resourceId ?? null,
            JSON.stringify(event.metadata ?? {}),
            event.ip ?? null,
            event.userAgent ?? null,
            event.requestId ?? null,
            row.outcome ?? "success",
          ],
        );
        return;
      }
    }
  } catch {
    /* file fallback */
  }
  const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "audit.jsonl"), JSON.stringify(row) + "\n", "utf8");
}

export type ListAuditOpts = {
  orgId?: string;
  limit?: number;
  offset?: number;
  action?: string;
  /** Prefix match on action (e.g. "scim.") */
  actionPrefix?: string;
  actorUserId?: string;
  resourceType?: string;
  outcome?: string;
  /** ISO date — inclusive lower bound */
  since?: string;
  /** ISO date — exclusive upper bound */
  until?: string;
};

function mapRow(r: {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  ip?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
  outcome?: string | null;
  created_at: Date | string;
}): AuditEvent {
  return {
    id: r.id,
    action: r.action,
    orgId: r.org_id ?? undefined,
    actorUserId: r.actor_user_id ?? undefined,
    resourceType: r.resource_type ?? undefined,
    resourceId: r.resource_id ?? undefined,
    metadata:
      typeof r.metadata === "object" && r.metadata
        ? (r.metadata as Record<string, unknown>)
        : {},
    ip: r.ip ?? undefined,
    userAgent: r.user_agent ?? undefined,
    requestId: r.request_id ?? undefined,
    outcome: r.outcome ?? undefined,
    createdAt:
      typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

/** List recent admin audit events for an org (SIEM-ready). */
export async function listAuditEvents(opts: ListAuditOpts): Promise<AuditEvent[]> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = Math.max(0, opts.offset ?? 0);
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.pool) {
        const params: unknown[] = [];
        const clauses: string[] = [];
        if (opts.orgId) {
          params.push(opts.orgId);
          clauses.push(`org_id = $${params.length}`);
        }
        if (opts.action) {
          params.push(opts.action);
          clauses.push(`action = $${params.length}`);
        }
        if (opts.actionPrefix) {
          params.push(`${opts.actionPrefix}%`);
          clauses.push(`action LIKE $${params.length}`);
        }
        if (opts.actorUserId) {
          params.push(opts.actorUserId);
          clauses.push(`actor_user_id = $${params.length}`);
        }
        if (opts.resourceType) {
          params.push(opts.resourceType);
          clauses.push(`resource_type = $${params.length}`);
        }
        if (opts.outcome) {
          params.push(opts.outcome);
          clauses.push(`outcome = $${params.length}`);
        }
        if (opts.since) {
          params.push(opts.since);
          clauses.push(`created_at >= $${params.length}::timestamptz`);
        }
        if (opts.until) {
          params.push(opts.until);
          clauses.push(`created_at < $${params.length}::timestamptz`);
        }
        params.push(limit);
        params.push(offset);
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const res = await db.pool.query(
          `SELECT id, org_id, actor_user_id, action, resource_type, resource_id, metadata,
                  ip, user_agent, request_id, outcome, created_at
           FROM audit_events ${where}
           ORDER BY created_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return res.rows.map((r) => mapRow(r as never));
      }
    }
  } catch {
    /* file */
  }

  try {
    const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const events: AuditEvent[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]!) as AuditEvent;
        if (opts.orgId && ev.orgId && ev.orgId !== opts.orgId) continue;
        if (opts.action && ev.action !== opts.action) continue;
        if (opts.actionPrefix && !ev.action.startsWith(opts.actionPrefix)) continue;
        if (opts.actorUserId && ev.actorUserId !== opts.actorUserId) continue;
        if (opts.resourceType && ev.resourceType !== opts.resourceType) continue;
        if (opts.outcome && ev.outcome !== opts.outcome) continue;
        if (opts.since && ev.createdAt < opts.since) continue;
        if (opts.until && ev.createdAt >= opts.until) continue;
        events.push(ev);
      } catch {
        /* skip bad line */
      }
    }
    return events.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export async function countAuditEvents(
  opts: Omit<ListAuditOpts, "limit" | "offset">,
): Promise<number> {
  // Cheap path for UI: fetch up to 1000 and count when file; SQL COUNT when PG
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.pool) {
        const params: unknown[] = [];
        const clauses: string[] = [];
        if (opts.orgId) {
          params.push(opts.orgId);
          clauses.push(`org_id = $${params.length}`);
        }
        if (opts.actionPrefix) {
          params.push(`${opts.actionPrefix}%`);
          clauses.push(`action LIKE $${params.length}`);
        }
        if (opts.action) {
          params.push(opts.action);
          clauses.push(`action = $${params.length}`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const res = await db.pool.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM audit_events ${where}`,
          params,
        );
        return Number(res.rows[0]?.c ?? 0);
      }
    }
  } catch {
    /* fall through */
  }
  const rows = await listAuditEvents({ ...opts, limit: 1000, offset: 0 });
  return rows.length;
}

/** Delete events older than retention. Returns deleted count. */
export async function pruneAuditEvents(opts?: {
  retentionDays?: number;
  orgId?: string;
}): Promise<number> {
  const days = opts?.retentionDays ?? Number(process.env.STEW_AUDIT_RETENTION_DAYS ?? 365);
  if (!Number.isFinite(days) || days < 1) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const { isDatabaseEnabled, tryCreateStewardDb } = await import("@codesteward/db");
    if (isDatabaseEnabled()) {
      const db = tryCreateStewardDb();
      if (db?.pool) {
        if (opts?.orgId) {
          const res = await db.pool.query(
            `DELETE FROM audit_events WHERE created_at < $1::timestamptz AND org_id = $2`,
            [cutoff, opts.orgId],
          );
          return res.rowCount ?? 0;
        }
        const res = await db.pool.query(
          `DELETE FROM audit_events WHERE created_at < $1::timestamptz`,
          [cutoff],
        );
        return res.rowCount ?? 0;
      }
    }
  } catch {
    /* file */
  }
  try {
    const dir = process.env.STEW_DATA_DIR ?? ".steward-data";
    const path = join(dir, "audit.jsonl");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const kept: string[] = [];
    let deleted = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as AuditEvent;
        if (ev.createdAt < cutoff && (!opts?.orgId || ev.orgId === opts.orgId)) {
          deleted++;
          continue;
        }
        kept.push(line);
      } catch {
        kept.push(line);
      }
    }
    if (deleted > 0) {
      await writeFile(path, kept.length ? kept.join("\n") + "\n" : "", "utf8");
    }
    return deleted;
  } catch {
    return 0;
  }
}

/** Helper for route handlers — extract request context for audit. */
export function auditContextFromRequest(c: {
  req: {
    header: (n: string) => string | undefined;
  };
  get: (k: string) => unknown;
}): Pick<AuditLogInput, "actorUserId" | "orgId" | "ip" | "userAgent" | "requestId"> {
  const user = c.get("user") as { id?: string } | undefined;
  return {
    actorUserId: user?.id,
    orgId: (c.get("orgId") as string | undefined) ?? "local",
    ip:
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      undefined,
    userAgent: c.req.header("user-agent") ?? undefined,
    requestId: c.req.header("x-request-id") ?? undefined,
  };
}
