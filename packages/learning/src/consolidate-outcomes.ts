/**
 * Promote outcome history → durable memories with correct scope:
 *
 * - Pattern only common in **one** repo  → repo-scoped memory
 * - Pattern common across **≥2 repos**     → org-scoped memory
 * - Pattern **important enough** (critical/high, gate regret, strong confidence)
 *   can promote to **org** even from a single repo
 *
 * Frequency thresholds avoid one-off merge noise becoming permanent policy.
 */
import type { FindingOutcome } from "@codesteward/core";
import type { LearningScope, OrgMemory } from "./types.js";
import type { OutcomeStore } from "./outcome-store.js";
import type { LearningStore } from "./store.js";

export type PromotionPolarity = "positive" | "negative";

export interface ConsolidateOptions {
  orgId: string;
  /** Look back this many days (default 90). */
  windowDays?: number;
  /** Min outcomes in a single repo before repo-scoped promotion (default 3). */
  minRepoCount?: number;
  /** Min distinct repos before multi-repo → org promotion (default 2). */
  minOrgRepos?: number;
  /** Min total outcomes before multi-repo org promotion (default 3). */
  minOrgCount?: number;
  /** Min outcomes for important single-repo → org (default 2). */
  minImportantCount?: number;
  /** Severities that can elevate single-repo patterns to org. */
  importantSeverities?: string[];
  /** Min confidence on outcomes counted (default 0.5). */
  minConfidence?: number;
  /** Cap auto-created memories per run (default 40). */
  maxPromotions?: number;
}

export interface PlannedPromotion {
  key: string;
  scope: LearningScope;
  repoId?: string;
  polarity: PromotionPolarity;
  kind: OrgMemory["kind"];
  fingerprint?: string;
  pattern?: string;
  title: string;
  body: string;
  weight: number;
  evidence: {
    total: number;
    repos: string[];
    byKind: Record<string, number>;
    important: boolean;
    reason: string;
  };
}

export interface ConsolidateResult {
  orgId: string;
  scanned: number;
  planned: PlannedPromotion[];
  written: number;
  updated: number;
  skipped: number;
  promotions: Array<{
    promotion: PlannedPromotion;
    memoryId: string;
    action: "created" | "updated";
  }>;
}

const POSITIVE_KINDS = new Set([
  "accepted",
  "fixed",
  "thumbs_up",
  "agent_miss_candidate",
  "gate_regret_miss",
]);
const NEGATIVE_KINDS = new Set(["false_positive", "dismissed"]);
const COUNTABLE = new Set([
  "accepted",
  "fixed",
  "thumbs_up",
  "false_positive",
  "dismissed",
  "agent_miss_candidate",
  "gate_regret_miss",
]);

function groupKey(o: FindingOutcome): string | null {
  if (o.fingerprint) return `fp:${o.fingerprint}`;
  if (o.kind === "agent_miss_candidate") {
    const path = (o.metadata?.path as string) || "";
    if (!path) return null;
    return `path:${path.replace(/\\/g, "/")}`;
  }
  return null;
}

function isImportant(
  o: FindingOutcome,
  importantSeverities: Set<string>,
): boolean {
  if (o.kind === "gate_regret_miss") return true;
  const sev = String(o.metadata?.severity ?? "").toLowerCase();
  if (sev && importantSeverities.has(sev)) return true;
  if ((o.confidence ?? 0) >= 0.9 && POSITIVE_KINDS.has(o.kind)) return true;
  return false;
}

/**
 * Pure planner: outcome rows → scoped promotion intents (repo vs org).
 */
export function planOutcomePromotions(
  outcomes: FindingOutcome[],
  opts: ConsolidateOptions,
): PlannedPromotion[] {
  const minRepoCount = opts.minRepoCount ?? 3;
  const minOrgRepos = opts.minOrgRepos ?? 2;
  const minOrgCount = opts.minOrgCount ?? 3;
  const minImportantCount = opts.minImportantCount ?? 2;
  const minConfidence = opts.minConfidence ?? 0.5;
  const maxPromotions = opts.maxPromotions ?? 40;
  const importantSeverities = new Set(
    (opts.importantSeverities ?? ["critical", "high"]).map((s) =>
      s.toLowerCase(),
    ),
  );
  const windowDays = opts.windowDays ?? 90;
  const cutoff = Date.now() - windowDays * 86400000;

  const filtered = outcomes.filter((o) => {
    if (o.orgId !== opts.orgId) return false;
    if (!COUNTABLE.has(o.kind)) return false;
    if (
      (o.confidence ?? 1) < minConfidence &&
      o.kind !== "agent_miss_candidate" &&
      o.kind !== "gate_regret_miss"
    ) {
      return false;
    }
    const t = Date.parse(o.createdAt);
    if (Number.isFinite(t) && t < cutoff) return false;
    return groupKey(o) != null;
  });

  type Agg = {
    key: string;
    fingerprint?: string;
    pattern?: string;
    byKind: Record<string, number>;
    byRepo: Map<string, number>;
    important: boolean;
    titles: string[];
  };

  const groups = new Map<string, Agg>();
  for (const o of filtered) {
    const key = groupKey(o)!;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        fingerprint: o.fingerprint,
        pattern:
          o.kind === "agent_miss_candidate"
            ? String(o.metadata?.path ?? "")
            : undefined,
        byKind: {},
        byRepo: new Map(),
        important: false,
        titles: [],
      };
      groups.set(key, g);
    }
    g.byKind[o.kind] = (g.byKind[o.kind] ?? 0) + 1;
    g.byRepo.set(o.repoId, (g.byRepo.get(o.repoId) ?? 0) + 1);
    if (isImportant(o, importantSeverities)) g.important = true;
    if (o.note) g.titles.push(o.note.slice(0, 80));
  }

  const planned: PlannedPromotion[] = [];

  for (const g of groups.values()) {
    const total = Object.values(g.byKind).reduce((a, b) => a + b, 0);
    const repos = [...g.byRepo.keys()];
    let pos = 0;
    let neg = 0;
    for (const [k, n] of Object.entries(g.byKind)) {
      if (POSITIVE_KINDS.has(k)) pos += n;
      if (NEGATIVE_KINDS.has(k)) neg += n;
    }

    let polarity: PromotionPolarity | null = null;
    // Negative needs clear majority (don't suppress from weak noise)
    if (neg >= minRepoCount && neg > pos) polarity = "negative";
    else if (pos >= minRepoCount && pos > neg) polarity = "positive";
    else if (g.important && pos >= minImportantCount && pos > neg) {
      polarity = "positive";
    } else {
      continue;
    }

    let topRepo = repos[0]!;
    let topCount = 0;
    for (const [r, c] of g.byRepo) {
      if (c > topCount) {
        topCount = c;
        topRepo = r;
      }
    }

    const multiRepo = repos.length >= minOrgRepos && total >= minOrgCount;
    const singleRepoStrong = topCount >= minRepoCount;
    const importantOrg =
      g.important &&
      (topCount >= minImportantCount || total >= minImportantCount);

    let scope: LearningScope;
    let reason: string;
    if (multiRepo) {
      scope = "org";
      reason = `seen in ${repos.length} repos (${total} outcomes) → org memory`;
    } else if (importantOrg) {
      scope = "org";
      reason = `important signal (severity/gate/confidence) mostly in ${topRepo} → org memory`;
    } else if (singleRepoStrong) {
      scope = "repo";
      reason = `common in repo ${topRepo} only (${topCount} outcomes) → repo memory`;
    } else {
      continue;
    }

    const signal = polarity === "positive" ? pos : neg;
    const weight = Math.min(
      1,
      0.55 + signal * 0.08 + (scope === "org" ? 0.1 : 0) + (g.important ? 0.05 : 0),
    );

    const kind: OrgMemory["kind"] =
      polarity === "negative"
        ? "dismissal"
        : g.pattern
          ? "pattern"
          : "preference";

    const label = g.fingerprint
      ? `fingerprint ${g.fingerprint.slice(0, 16)}`
      : g.pattern
        ? `path ${g.pattern}`
        : g.key;

    planned.push({
      key: g.key,
      scope,
      repoId: scope === "repo" ? topRepo : undefined,
      polarity,
      kind,
      fingerprint: g.fingerprint,
      pattern: g.pattern || undefined,
      title:
        polarity === "positive"
          ? `Auto: keep watching ${label}`
          : `Auto: suppress ${label}`,
      body: [
        `Promoted from outcome history (${windowDays}d window).`,
        reason,
        `counts=${JSON.stringify(g.byKind)}`,
        `repos=${repos.join(",")}`,
        g.titles[0] ? `example: ${g.titles[0]}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      weight,
      evidence: {
        total,
        repos,
        byKind: { ...g.byKind },
        important: g.important,
        reason,
      },
    });
  }

  planned.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "org" ? -1 : 1;
    return b.weight - a.weight;
  });
  return planned.slice(0, maxPromotions);
}

/**
 * Load outcomes, plan promotions, upsert LearningStore with repo vs org scope.
 * Idempotent: source=outcome_aggregate + fingerprint/pattern + scope(+repo).
 */
export async function consolidateOutcomeMemories(
  outcomeStore: OutcomeStore,
  learning: LearningStore,
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const outcomes = await outcomeStore.listFindingOutcomes({
    orgId: opts.orgId,
    limit: 5000,
  });
  const planned = planOutcomePromotions(outcomes, opts);
  const existing = await learning.listMemories({ orgId: opts.orgId });

  let written = 0;
  let updated = 0;
  let skipped = 0;
  const promotions: ConsolidateResult["promotions"] = [];

  for (const p of planned) {
    const match = existing.find((m) => memoryMatchesPromotion(m, p, opts.orgId));

    if (match) {
      const matchScope = inferScope(match);
      if (
        (match.weight ?? 0) >= p.weight - 0.01 &&
        match.polarity === p.polarity &&
        matchScope === p.scope &&
        (p.scope !== "repo" || match.repoId === p.repoId)
      ) {
        skipped++;
        continue;
      }
      // Stronger evidence or scope upgrade (repo → org): replace
      try {
        await learning.deleteMemory(match.id);
      } catch {
        /* create anyway */
      }
    }

    try {
      const mem = await learning.addMemory({
        orgId: opts.orgId,
        scope: p.scope,
        repoId: p.repoId,
        kind: p.kind,
        polarity: p.polarity,
        fingerprint: p.fingerprint,
        pattern: p.pattern,
        title: p.title,
        body: p.body,
        source: "outcome_aggregate",
        weight: p.weight,
      });
      if (match) updated++;
      else written++;
      promotions.push({
        promotion: p,
        memoryId: mem.id,
        action: match ? "updated" : "created",
      });
      // keep existing list in sync for later matches in same run
      existing.push(mem);
    } catch {
      skipped++;
    }
  }

  return {
    orgId: opts.orgId,
    scanned: outcomes.length,
    planned,
    written,
    updated,
    skipped,
    promotions,
  };
}

function memoryMatchesPromotion(
  m: OrgMemory,
  p: PlannedPromotion,
  orgId: string,
): boolean {
  if (m.source !== "outcome_aggregate") return false;
  if (m.orgId !== orgId) return false;
  if (p.fingerprint && m.fingerprint === p.fingerprint) return true;
  if (p.pattern && m.pattern === p.pattern) return true;
  return false;
}

function inferScope(m: {
  scope?: string;
  repoId?: string;
  prKey?: string;
}): LearningScope {
  if (m.scope === "org" || m.scope === "repo" || m.scope === "pr") return m.scope;
  if (m.prKey) return "pr";
  if (m.repoId) return "repo";
  return "org";
}
