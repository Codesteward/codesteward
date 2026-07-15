/**
 * Seed cross-repo edges into Codesteward Graph after each linked repo is rebuilt.
 *
 * Per-repo graphs stay separate (repo_id scoped). Cross-repo connections are
 * written via graph_augment so referential / agent queries can see the link
 * (depends_on_api, package, etc.) between the primary and linked repos.
 */
import type { CrossRepoLink } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";

export interface SeedCrossRepoGraphOpts {
  graph: GraphClient;
  tenantId: string;
  primaryRepoId: string;
  links: CrossRepoLink[];
  /** Repos that were successfully materialized + rebuilt this session */
  readyRepoIds: string[];
  agentId?: string;
}

function repoNodeId(tenantId: string, repoId: string): string {
  // Synthetic repo-level node — agents can still traverse link edges
  const safe = repoId.replace(/[^a-zA-Z0-9_./-]/g, "_");
  return `module:${tenantId}:${safe}:__repo__:${safe}`;
}

/**
 * For each enabled org link touching the primary + a ready linked repo,
 * write a bidirectional-ish edge set via graph_augment.
 */
export async function seedCrossRepoGraphEdges(
  opts: SeedCrossRepoGraphOpts,
): Promise<{ written: number; skipped: number; errors: string[] }> {
  const ready = new Set(opts.readyRepoIds);
  if (!ready.has(opts.primaryRepoId)) {
    return { written: 0, skipped: 0, errors: ["primary not ready"] };
  }

  const additions: Array<{
    source_id: string;
    edge_type: string;
    target_id: string;
    target_name: string;
    confidence: number;
    rationale?: string;
  }> = [];

  const primaryNode = repoNodeId(opts.tenantId, opts.primaryRepoId);

  for (const link of opts.links) {
    if (!link.enabled) continue;
    const a = link.fromRepoId;
    const b = link.toRepoId;
    // Only seed when both ends are ready (or one is primary and other ready)
    if (!ready.has(a) || !ready.has(b)) continue;
    if (a !== opts.primaryRepoId && b !== opts.primaryRepoId) {
      // Still seed links among fan-out set when both ready
    }

    const fromNode = repoNodeId(opts.tenantId, a);
    const toNode = repoNodeId(opts.tenantId, b);
    const edgeType = String(link.edgeType || "depends_on_api");
    const pkg = link.hints?.packageName;
    const rationale = [
      `Org cross-repo link ${a} --${edgeType}--> ${b}`,
      pkg ? `package=${pkg}` : "",
      link.hints?.apiPrefix ? `apiPrefix=${link.hints.apiPrefix}` : "",
      link.hints?.notes ? `notes=${link.hints.notes.slice(0, 120)}` : "",
    ]
      .filter(Boolean)
      .join("; ");

    additions.push({
      source_id: fromNode,
      edge_type: edgeType,
      target_id: toNode,
      target_name: b,
      confidence: 0.85,
      rationale,
    });
    // Reverse navigability for agents
    additions.push({
      source_id: toNode,
      edge_type: `inverse_${edgeType}`,
      target_id: fromNode,
      target_name: a,
      confidence: 0.7,
      rationale: `Inverse of ${rationale}`,
    });

    // Optional: package-named edge from primary when reviewing primary
    if (pkg && (a === opts.primaryRepoId || b === opts.primaryRepoId)) {
      const other = a === opts.primaryRepoId ? b : a;
      additions.push({
        source_id: primaryNode,
        edge_type: "imports_package",
        target_id: repoNodeId(opts.tenantId, other),
        target_name: pkg,
        confidence: 0.75,
        rationale: `Link hint packageName=${pkg} → ${other}`,
      });
    }
  }

  if (!additions.length) {
    return { written: 0, skipped: 0, errors: [] };
  }

  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  // Augment against primary repo scope (edges may reference other repo_ids in node ids)
  try {
    const res = await opts.graph.augment(
      opts.agentId ?? "codesteward-cross-repo",
      additions.map((a) => ({
        source_id: a.source_id,
        edge_type: a.edge_type,
        target_id: a.target_id,
        target_name: a.target_name,
        confidence: a.confidence,
        rationale: a.rationale,
      })),
      { tenantId: opts.tenantId, repoId: opts.primaryRepoId },
    );
    written += res.written ?? 0;
    skipped += res.skipped ?? 0;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { written, skipped, errors };
}
