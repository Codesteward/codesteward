/**
 * Materialize (clone or mount) linked repos for cross-repo review so fan-out
 * units scan real trees — not just the primary job.repoPath.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { CrossRepoLink } from "@codesteward/core";
import {
  materializeGitWorkspace,
  parseOwnerRepo,
} from "@codesteward/scm";

export interface CloneAuth {
  provider: string;
  token?: string;
  host?: string;
}

export interface MaterializedRepo {
  repoId: string;
  repoPath: string;
  source: "clone" | "mount" | "link_path" | "missing";
  verified?: boolean;
  notes: string[];
}

export interface MaterializeCrossRepoOpts {
  sessionId: string;
  primaryRepoId: string;
  /** Repos from fan-out (includes primary). */
  repoIds: string[];
  links: CrossRepoLink[];
  cloneAuth?: CloneAuth | null;
  workspaceRoot?: string;
  /** Product org — nests clones under {root}/{orgId}/{sessionId}/cross/… */
  orgId?: string;
  /** Default SCM provider when cloning owner/repo ids. */
  provider?: string;
}

function pathFromLink(links: CrossRepoLink[], repoId: string): string | undefined {
  for (const l of links) {
    if (l.fromRepoId === repoId && l.fromRepoPath) return l.fromRepoPath;
    if (l.toRepoId === repoId && l.toRepoPath) return l.toRepoPath;
  }
  return undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure every fan-out repo has a local path for packing + graph rebuild.
 * Primary is expected already prepared; linked repos are cloned under
 * `{workspaceRoot}/{orgId}/{sessionId}/cross/{owner__repo}` when SCM auth is available.
 */
export async function materializeCrossRepoWorkspaces(
  opts: MaterializeCrossRepoOpts,
): Promise<Map<string, MaterializedRepo>> {
  const out = new Map<string, MaterializedRepo>();
  const { sessionWorkspaceDir, tenantIsolationMode, workspaceRootDir } =
    await import("../path-jail.js");
  const rootBase = opts.workspaceRoot ?? workspaceRootDir();
  const sessionRoot =
    tenantIsolationMode() === "off"
      ? join(rootBase, opts.sessionId)
      : sessionWorkspaceDir({
          sessionId: opts.sessionId,
          orgId: opts.orgId,
          root: rootBase,
        });
  const provider = opts.provider ?? opts.cloneAuth?.provider ?? "github";
  const cloneForcedOff = process.env.STEW_WORKSPACE_CLONE === "0";

  for (const repoId of opts.repoIds) {
    if (repoId === opts.primaryRepoId) {
      // Primary path is set by prepareSessionWorkspace; placeholder until orchestrator fills it
      out.set(repoId, {
        repoId,
        repoPath: "",
        source: "mount",
        notes: ["primary — path filled by session workspace"],
      });
      continue;
    }

    const notes: string[] = [];
    const linkPath = pathFromLink(opts.links, repoId);
    if (linkPath && (await pathExists(linkPath))) {
      out.set(repoId, {
        repoId,
        repoPath: linkPath,
        source: "link_path",
        notes: [`Using configured link path ${linkPath}`],
      });
      continue;
    }
    if (linkPath) {
      notes.push(`Configured link path missing: ${linkPath}`);
    }

    const ownerRepo = parseOwnerRepo(repoId);
    if (
      !cloneForcedOff &&
      ownerRepo &&
      opts.cloneAuth?.token
    ) {
      const workdir = join(
        sessionRoot,
        "cross",
        `${ownerRepo.owner}__${ownerRepo.repo}`,
      );
      try {
        const mat = await materializeGitWorkspace({
          provider,
          owner: ownerRepo.owner,
          repo: ownerRepo.repo,
          workdir,
          token: opts.cloneAuth.token,
          host: opts.cloneAuth.host,
          // Linked repos: default branch tip (no PR head) — shallow fetch
          force: false,
        });
        if (mat.ok) {
          out.set(repoId, {
            repoId,
            repoPath: mat.workdir,
            source: "clone",
            verified: mat.verified,
            notes: [
              ...notes,
              `Cloned ${ownerRepo.owner}/${ownerRepo.repo}` +
                (mat.verifiedSha ? ` @ ${mat.verifiedSha.slice(0, 12)}` : ""),
            ],
          });
          continue;
        }
        notes.push(`Clone failed: ${mat.error ?? "unknown"}`);
      } catch (err) {
        notes.push(
          `Clone error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (cloneForcedOff) {
      notes.push("STEW_WORKSPACE_CLONE=0 — cannot clone linked repo");
    } else if (!opts.cloneAuth?.token) {
      notes.push("No SCM token — cannot clone linked repo");
    } else if (!ownerRepo) {
      notes.push(`repoId "${repoId}" is not owner/repo — set fromRepoPath/toRepoPath on the link`);
    }

    out.set(repoId, {
      repoId,
      repoPath: "",
      source: "missing",
      notes,
    });
  }

  return out;
}
