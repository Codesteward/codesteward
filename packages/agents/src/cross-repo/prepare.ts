/**
 * Cross-repo preparation used by the orchestrator:
 * discover links → materialize trees → graph_rebuild each repo → seed edges → fan-out units.
 *
 * Extracted so tests can assert rebuild is called per linked repo (not theory-only).
 */
import type { CrossRepoBudget, CrossRepoLink, ReviewUnit } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import { planCrossRepoFanOut } from "./fanout.js";
import { seedCrossRepoGraphEdges } from "./graph-links.js";
import {
  materializeCrossRepoWorkspaces,
  type CloneAuth,
  type MaterializedRepo,
} from "./materialize.js";

export interface CrossRepoPrepareLog {
  level: "info" | "warn" | "error";
  message: string;
}

export interface CrossRepoPrepareInput {
  sessionId: string;
  primaryRepoId: string;
  primaryRepoPath?: string;
  primaryPaths: string[];
  links: CrossRepoLink[];
  budget?: CrossRepoBudget;
  graph: GraphClient;
  tenantId: string;
  /** Product org for multi-tenant workspace layout */
  orgId?: string;
  cloneAuth?: CloneAuth | null;
  provider?: string;
  /**
   * When true (default), call graph.rebuild for every materialized linked repo.
   * Primary is rebuilt only if `rebuildPrimary` is true (orchestrator may have done it already).
   */
  rebuildLinkedGraphs?: boolean;
  /** Also rebuild primary under its repoId (default false — orchestrator graph stage handles it). */
  rebuildPrimary?: boolean;
  onLog?: (log: CrossRepoPrepareLog) => void | Promise<void>;
  onRebuild?: (info: {
    repoId: string;
    repoPath: string;
    ok: boolean;
    error?: string;
  }) => void | Promise<void>;
}

export interface CrossRepoPrepareResult {
  repos: string[];
  units: ReviewUnit[];
  skipped: Array<{ repoId: string; reason: string }>;
  materialized: Map<string, MaterializedRepo>;
  /** repoIds for which a local path was available */
  readyRepoIds: string[];
  /** repoIds that received a successful graph.rebuild in this prepare */
  rebuiltRepoIds: string[];
  /** repoIds where rebuild was attempted but failed */
  rebuildFailedRepoIds: string[];
  edgeSeed: { written: number; skipped: number; errors: string[] };
}

/**
 * Full cross-repo prepare pipeline. Callers (orchestrator) merge `units` into the plan.
 */
export async function prepareCrossRepoReview(
  input: CrossRepoPrepareInput,
): Promise<CrossRepoPrepareResult> {
  const log = async (level: CrossRepoPrepareLog["level"], message: string) => {
    await input.onLog?.({ level, message });
  };

  const preview = await planCrossRepoFanOut({
    sessionId: input.sessionId,
    primaryRepoId: input.primaryRepoId,
    primaryPaths: input.primaryPaths,
    links: input.links,
    budget: input.budget,
    graph: input.graph,
    tenantId: input.tenantId,
    orgId: input.orgId,
  });

  const materialized = await materializeCrossRepoWorkspaces({
    sessionId: input.sessionId,
    primaryRepoId: input.primaryRepoId,
    repoIds: preview.repos,
    links: input.links,
    cloneAuth: input.cloneAuth,
    orgId: input.orgId,
    provider: input.provider ?? input.cloneAuth?.provider ?? "github",
  });

  if (input.primaryRepoPath) {
    materialized.set(input.primaryRepoId, {
      repoId: input.primaryRepoId,
      repoPath: input.primaryRepoPath,
      source: "mount",
      notes: ["primary session workspace"],
    });
  }

  const readyRepoIds: string[] = [];
  const rebuiltRepoIds: string[] = [];
  const rebuildFailedRepoIds: string[] = [];
  const doLinked = input.rebuildLinkedGraphs !== false;

  for (const [repoId, mat] of materialized) {
    if (!mat.repoPath || mat.source === "missing") {
      if (repoId !== input.primaryRepoId) {
        await log(
          "warn",
          `Cross-repo ${repoId}: not available — ${mat.notes.join("; ") || "no path"}`,
        );
      }
      continue;
    }
    readyRepoIds.push(repoId);

    const isPrimary = repoId === input.primaryRepoId;
    if (isPrimary && !input.rebuildPrimary) continue;
    if (!isPrimary && !doLinked) continue;

    await log(
      "info",
      `Cross-repo ${repoId}: ${mat.source} → ${mat.repoPath}${mat.notes.length ? ` (${mat.notes.join("; ")})` : ""}`,
    );

    try {
      const { graphTenantId } = await import("../graph-scope.js");
      const gTenant = graphTenantId(input.orgId, input.tenantId);
      await input.graph.rebuild({
        repoPath: mat.repoPath,
        tenantId: gTenant,
        repoId,
      });
      rebuiltRepoIds.push(repoId);
      await input.onRebuild?.({ repoId, repoPath: mat.repoPath, ok: true });
      await log("info", `Graph rebuilt for ${isPrimary ? "primary" : "linked"} repo ${repoId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rebuildFailedRepoIds.push(repoId);
      await input.onRebuild?.({
        repoId,
        repoPath: mat.repoPath,
        ok: false,
        error: msg,
      });
      await log("warn", `Graph rebuild failed for ${repoId}: ${msg}`);
    }
  }

  let edgeSeed: { written: number; skipped: number; errors: string[] };
  try {
    const { graphTenantId } = await import("../graph-scope.js");
    edgeSeed = await seedCrossRepoGraphEdges({
      graph: input.graph,
      tenantId: graphTenantId(input.orgId, input.tenantId),
      primaryRepoId: input.primaryRepoId,
      links: input.links,
      readyRepoIds,
    });
    if (edgeSeed.written || edgeSeed.errors.length) {
      await log(
        edgeSeed.errors.length ? "warn" : "info",
        `Cross-repo graph edges: written=${edgeSeed.written} skipped=${edgeSeed.skipped}${edgeSeed.errors.length ? ` errors=${edgeSeed.errors.join("; ")}` : ""}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    edgeSeed = { written: 0, skipped: 0, errors: [msg] };
    await log("warn", `Cross-repo graph edge seed failed: ${msg}`);
  }

  const fan = await planCrossRepoFanOut({
    sessionId: input.sessionId,
    primaryRepoId: input.primaryRepoId,
    primaryPaths: input.primaryPaths,
    links: input.links,
    budget: input.budget,
    graph: input.graph,
    tenantId: input.tenantId,
    orgId: input.orgId,
    materialized,
  });

  if (fan.units.length) {
    await log(
      "info",
      `Cross-repo fan-out: +${fan.units.length} units across ${fan.repos.join(", ")} (skipped ${fan.skipped.length})`,
    );
  } else if (fan.skipped.length) {
    await log(
      "warn",
      `Cross-repo: no linked units — ${fan.skipped.map((s) => `${s.repoId}: ${s.reason}`).join("; ")}`,
    );
  }

  return {
    repos: fan.repos,
    units: fan.units,
    skipped: fan.skipped,
    materialized,
    readyRepoIds,
    rebuiltRepoIds,
    rebuildFailedRepoIds,
    edgeSeed,
  };
}
