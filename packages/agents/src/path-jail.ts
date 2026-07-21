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

/** True if path looks like a container/host absolute path (not a virtual /src/foo). */
function looksLikeHostAbsolute(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("/workspace") || p.startsWith("/var/") || p.startsWith("/tmp/")) {
    return true;
  }
  if (p.startsWith("/home/") || p.startsWith("/Users/") || p.startsWith("/repos/")) {
    return true;
  }
  // /local/ses_… or /org/ses_… session trees
  if (/^\/[a-z0-9._-]+\/ses_[a-z0-9]+\//i.test(p)) return true;
  return false;
}

/**
 * Map agent-supplied paths into a path relative to the unit workspace root.
 *
 * Handles common model mistakes for cross-repo units:
 * - missing leading `/` (`workspace/local/ses_…/cross/Owner__repo`)
 * - full host paths while the unit root is already the linked clone
 * - virtual absolute paths (`/src/foo.ts`) under the unit root only
 *
 * Always jails to `workspaceRoot` (throws on escape).
 */
export function normalizeReviewToolPath(
  userPath: string,
  workspaceRoot: string,
): string {
  const root = resolve(workspaceRoot);
  const rootBase = root.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const rootNorm = root.replace(/\\/g, "/");
  let p = (userPath ?? "").trim() || ".";

  // Model often omits leading slash: workspace/local/ses_…/cross/…
  if (
    /^(workspace|local)\//i.test(p) ||
    /^[a-z0-9._-]+\/ses_[a-z0-9]+\//i.test(p)
  ) {
    p = `/${p}`;
  }

  // Host-style absolute path (container /workspace/… or absolute session path)
  if (looksLikeHostAbsolute(p)) {
    let abs: string;
    try {
      abs = resolve(p);
    } catch {
      abs = p;
    }
    const absNorm = abs.replace(/\\/g, "/");

    // Refuse other sessions under the same workspace volume
    const pathSes = absNorm.match(/\/(ses_[a-z0-9]+)\//i)?.[1];
    const rootSes = rootNorm.match(/\/(ses_[a-z0-9]+)\//i)?.[1];
    if (pathSes && rootSes && pathSes !== rootSes) {
      throw new Error(
        `path escapes review workspace (refusing other session ${pathSes})`,
      );
    }

    if (absNorm === rootNorm || absNorm.startsWith(`${rootNorm}/`)) {
      return absNorm.slice(rootNorm.length).replace(/^\/+/, "") || ".";
    }

    // …/cross/Owner__repo[/rest] while unit root is that Owner__repo clone
    const crossMatch = absNorm.match(/\/cross\/([^/]+)(?:\/(.*))?$/);
    if (crossMatch) {
      const seg = crossMatch[1] ?? "";
      const rest = crossMatch[2] ?? "";
      if (seg === rootBase) {
        return rest || ".";
      }
      // Unit root is session root — only if this absolute path is under it
      if (absNorm.startsWith(`${rootNorm}/`)) {
        return absNorm.slice(rootNorm.length).replace(/^\/+/, "") || ".";
      }
    }

    throw new Error(
      `path escapes review workspace (refusing ${p.slice(0, 160)})`,
    );
  }

  // Virtual absolute under unit root (/src/foo.ts → src/foo.ts)
  if (p.startsWith("/")) {
    p = p.replace(/^\/+/, "") || ".";
  }
  p = p.replace(/^\.\//, "");

  // cross/Owner__repo[/…] while root is already that clone
  const crossPref = `cross/${rootBase}`;
  if (p === crossPref || p.startsWith(`${crossPref}/`)) {
    p = p.slice(crossPref.length).replace(/^\/+/, "") || ".";
  } else {
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)cross\/([^/]+)(?:\/(.*))?$/);
    if (m && m[1] === rootBase) {
      p = m[2] || ".";
    }
  }

  // Final jail
  const abs = resolveInsideRoot(root, p);
  return abs.slice(root.length).replace(/^[/\\]+/, "") || ".";
}

/**
 * Virtual absolute path for DeepAgents FilesystemBackend (virtualMode).
 * Always returns a path starting with `/` — DeepAgents tools/docs require this
 * even when permissions middleware is disabled.
 */
export function toVirtualReviewPath(relativePath: string): string {
  let r = (relativePath ?? "").trim().replace(/\\/g, "/");
  if (!r || r === "." || r === "./") return "/";
  // Collapse accidental `//` and strip trailing dots-only segments
  r = r.replace(/\/{2,}/g, "/");
  if (r === "/" || r === "/.") return "/";
  return r.startsWith("/") ? r : `/${r}`;
}

/**
 * True if a path token looks like a host/session/cross tree path the model
 * invents (not a normal repo-relative path like `src/foo.ts`).
 */
export function looksLikeHostOrSessionPath(token: string): boolean {
  const t = (token ?? "").trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!t || t === "." || t === "/") return false;
  if (looksLikeHostAbsolute(t)) return true;
  if (/^(workspace|local)\//i.test(t)) return true;
  if (/^[a-z0-9._-]+\/ses_[a-z0-9]+\//i.test(t)) return true;
  if (/(?:^|\/)cross\/[A-Za-z0-9._-]+(?:__|\/)/.test(t)) return true;
  if (/\/ses_[a-z0-9]+\//i.test(t)) return true;
  return false;
}

export type RewriteShellPathsResult =
  | { ok: true; command: string; rewrote: boolean }
  | { ok: false; reason: string };

/**
 * Best-effort rewrite of host/session/cross path tokens inside a shell command
 * so they resolve under the unit workspace (cwd = unit root).
 *
 * - Tokens that map into this unit are rewritten to unit-relative paths
 * - Tokens that escape (other session / outside unit) refuse the whole command
 * - Parent traversal (`..`) is always refused
 *
 * Not a full shell parser — covers the common model patterns that caused
 * `ls: cannot access 'workspace/local/ses_…/cross/…'`.
 */
export function rewriteShellCommandPaths(
  command: string,
  workspaceRoot: string,
): RewriteShellPathsResult {
  const cmd = command ?? "";
  if (/(?:^|[\s;'"`])\.\.(\/|\\|$)/.test(cmd)) {
    return {
      ok: false,
      reason:
        "refused: relative parent paths (`..`) are not allowed under multi-tenant isolation",
    };
  }

  // Host/session/cross-looking path tokens (optional surrounding quotes).
  // Examples:
  //   workspace/local/ses_x/cross/Owner__repo
  //   /workspace/local/ses_x/cross/Owner__repo/src
  //   'local/ses_x/cross/Owner__repo'
  //   cross/Owner__repo/pkg
  const pathRe =
    /(['"`]?)((?:\/?(?:workspace|local)\/[^\s;'"`]+)|(?:\/workspace\/[^\s;'"`]+)|(?:[a-z0-9._-]+\/ses_[a-z0-9]+\/[^\s;'"`]+)|(?:(?<=^|[\s=;|&()<>])cross\/[A-Za-z0-9._-]+(?:__[A-Za-z0-9._-]+)?(?:\/[^\s;'"`]*)?))(\1)/gi;

  let rewrote = false;
  try {
    const out = cmd.replace(pathRe, (full, q: string, raw: string) => {
      if (!looksLikeHostOrSessionPath(raw)) return full;
      const rel = normalizeReviewToolPath(raw, workspaceRoot);
      rewrote = true;
      const safe = !rel || rel === "." ? "." : rel;
      return q ? `${q}${safe}${q}` : safe;
    });
    return { ok: true, command: rewrote ? out : cmd, rewrote };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? err.message
          : "refused: path escapes review workspace",
    };
  }
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
