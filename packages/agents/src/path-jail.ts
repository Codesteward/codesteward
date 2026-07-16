/**
 * Filesystem containment helpers for multi-tenant workers.
 * Prevents path traversal / sibling-session reads when tools run on a shared host.
 */
import { isAbsolute, join, resolve } from "node:path";

/** Safe single path segment for org id (no slashes / traversal). */
export function sanitizeOrgSegment(orgId: string | undefined | null): string {
  const raw = (orgId ?? "local").trim() || "local";
  const s = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 64);
  return s || "local";
}

export function workspaceRootDir(): string {
  return resolve(
    process.env.STEW_WORKSPACE_DIR ??
      join(process.env.STEW_DATA_DIR ?? ".steward-data", "workspaces"),
  );
}

/**
 * Session clone tree: `{STEW_WORKSPACE_DIR}/{orgId}/{sessionId}`
 * Org prefix reduces accidental cross-tenant walks and enables per-org volume mounts.
 */
export function sessionWorkspaceDir(opts: {
  sessionId: string;
  orgId?: string | null;
  root?: string;
}): string {
  const root = opts.root ? resolve(opts.root) : workspaceRootDir();
  return join(root, sanitizeOrgSegment(opts.orgId), opts.sessionId);
}

/** True if abs path is root or a strict child of root. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  const abs = resolve(candidate);
  return abs === base || abs.startsWith(base + "/") || abs.startsWith(base + "\\");
}

/**
 * Resolve user-supplied path under root; throw if it escapes (incl. `..` and abs outside).
 */
export function resolveInsideRoot(root: string, userPath: string): string {
  const base = resolve(root);
  const cleaned = (userPath ?? "").trim() || ".";
  const target = isAbsolute(cleaned) ? resolve(cleaned) : resolve(base, cleaned);
  if (!isPathInsideRoot(base, target)) {
    throw new Error(
      `path escapes review workspace (refusing ${cleaned.slice(0, 120)})`,
    );
  }
  return target;
}

/**
 * Multi-tenant hardening level:
 * - off: legacy flat layout still supported for GC of old sessions
 * - path (default): org-prefixed workspaces + tool path jail
 * - strict: path + require docker/k8s sandbox (no host-local shell for agents)
 */
export function tenantIsolationMode(): "off" | "path" | "strict" {
  const v = (process.env.STEW_TENANT_ISOLATION ?? "path").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "none") return "off";
  if (v === "strict" || v === "hard" || v === "2") return "strict";
  return "path";
}
