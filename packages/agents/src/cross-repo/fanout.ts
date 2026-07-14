import {
  defaultCrossRepoBudget,
  type CrossRepoBudget,
  type CrossRepoLink,
  type ReviewUnit,
  unitId,
} from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";

export interface FanOutInput {
  sessionId: string;
  primaryRepoId: string;
  primaryPaths: string[];
  links: CrossRepoLink[];
  budget?: CrossRepoBudget;
  graph?: GraphClient;
  tenantId?: string;
  /** Roles to assign on fan-out units */
  assignedRoles?: string[];
}

export interface FanOutResult {
  repos: string[];
  units: ReviewUnit[];
  contextByRepo: Record<string, string>;
  skipped: Array<{ repoId: string; reason: string }>;
}

/**
 * Expand review to linked repositories under budget.
 * BFS from primary repo following enabled CrossRepoLink edges.
 */
export async function planCrossRepoFanOut(input: FanOutInput): Promise<FanOutResult> {
  const budget = input.budget ?? defaultCrossRepoBudget();
  const enabled = input.links.filter((l) => l.enabled);
  const skipped: FanOutResult["skipped"] = [];
  const contextByRepo: Record<string, string> = {};
  const units: ReviewUnit[] = [];

  const visited = new Set<string>([input.primaryRepoId]);
  type Node = { repoId: string; depth: number };
  const queue: Node[] = [{ repoId: input.primaryRepoId, depth: 0 }];
  const repos: string[] = [input.primaryRepoId];

  while (queue.length && repos.length < budget.maxRepos) {
    const cur = queue.shift()!;
    if (cur.depth >= budget.maxDepth) continue;

    const outgoing = enabled.filter(
      (l) => l.fromRepoId === cur.repoId || l.toRepoId === cur.repoId,
    );

    for (const link of outgoing) {
      const nextId =
        link.fromRepoId === cur.repoId ? link.toRepoId : link.fromRepoId;
      if (visited.has(nextId)) continue;
      if (repos.length >= budget.maxRepos) {
        skipped.push({ repoId: nextId, reason: "maxRepos budget" });
        continue;
      }

      // Path filter: only fan-out if primary paths match from-side filters when leaving primary
      if (cur.repoId === input.primaryRepoId && link.pathFilters.from.length) {
        const hit = input.primaryPaths.some((p) =>
          link.pathFilters.from.some((g) => matchGlob(p, g)),
        );
        if (!hit && input.primaryPaths.length && input.primaryPaths[0] !== ".") {
          skipped.push({ repoId: nextId, reason: "pathFilters.from no match" });
          continue;
        }
      }

      visited.add(nextId);
      repos.push(nextId);
      queue.push({ repoId: nextId, depth: cur.depth + 1 });

      // Graph context slice
      let graphSnippet = "";
      if (input.graph) {
        try {
          const q = await input.graph.query("dependency", "", {
            tenantId: input.tenantId ?? "local",
            repoId: nextId,
            limit: 15,
          });
          graphSnippet = JSON.stringify(q.results?.slice?.(0, 10) ?? q).slice(0, 4000);
        } catch (err) {
          graphSnippet = `graph error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      contextByRepo[nextId] = [
        `Cross-repo edge: ${link.fromRepoId} --${link.edgeType}--> ${link.toRepoId}`,
        link.hints.notes ? `Notes: ${link.hints.notes}` : "",
        link.hints.apiPrefix ? `API prefix: ${link.hints.apiPrefix}` : "",
        graphSnippet ? `Graph deps:\n${graphSnippet}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      if (units.length >= budget.maxExtraUnits) {
        skipped.push({ repoId: nextId, reason: "maxExtraUnits" });
        continue;
      }

      const toPaths =
        link.pathFilters.to.length > 0
          ? link.pathFilters.to
          : link.toRepoPath
            ? ["."]
            : ["."];

      units.push({
        id: unitId(),
        sessionId: input.sessionId,
        kind: "path",
        label: `cross-repo:${nextId}`,
        paths: toPaths,
        symbols: [],
        status: "pending",
        assignedRoles: input.assignedRoles ?? ["security", "correctness"],
        metadata: {
          crossRepo: true,
          repoId: nextId,
          repoPath: link.fromRepoId === nextId ? link.fromRepoPath : link.toRepoPath,
          edgeType: link.edgeType,
          linkId: link.id,
          context: contextByRepo[nextId],
        },
      });
    }
  }

  return { repos, units, contextByRepo, skipped };
}

function matchGlob(path: string, glob: string): boolean {
  // Minimal glob: ** / * support
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${escaped}$`).test(path) || path.includes(glob.replace(/\*\*/g, "").replace(/\*/g, ""));
}
