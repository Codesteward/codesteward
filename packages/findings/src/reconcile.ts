/**
 * Re-review lifecycle: when a new review runs for the same PR (gate) or
 * branch (stewardship), update prior findings so fixed bugs close and
 * returning bugs reopen — instead of leaving stale "open" rows forever.
 */
import {
  computeFingerprint,
  nowIso,
  SEVERITY_RANK,
  type Finding,
  type FindingCandidate,
  type FindingStatus,
  type Severity,
} from "@codesteward/core";
import { assertTransition, canTransition } from "./lifecycle.js";
import type { FindingsStore } from "./store.js";

export interface FindingScope {
  orgId: string;
  repoId: string;
  mode: "gate" | "stewardship" | string;
  prNumber?: number;
  headBranch?: string;
}

export interface ReconcileResult {
  fixed: string[];
  reopened: string[];
  updated: string[];
  untouched: number;
}

const ACTIVE: FindingStatus[] = ["open", "acknowledged", "reopened"];
const USER_CLOSED: FindingStatus[] = [
  "dismissed",
  "wontfix",
  "false_positive",
  "suppressed",
];

export function scopeTags(scope: FindingScope): string[] {
  const tags: string[] = [];
  if (scope.mode === "gate" && scope.prNumber != null) {
    tags.push(`scope:pr:${scope.prNumber}`);
  }
  if (scope.headBranch) {
    tags.push(`scope:branch:${scope.headBranch}`);
  }
  return tags;
}

/** Whether a stored finding belongs to this PR/branch scope. */
export function findingMatchesScope(f: Finding, scope: FindingScope): boolean {
  if ((f.orgId ?? "local") !== (scope.orgId ?? "local")) return false;
  if (f.repoId !== scope.repoId) return false;
  const tags = f.tags ?? [];

  if (scope.mode === "gate" && scope.prNumber != null) {
    const want = `scope:pr:${scope.prNumber}`;
    if (tags.includes(want)) return true;
    // Legacy rows without PR tags: include only if they carry no other PR tag
    const otherPr = tags.some((t) => t.startsWith("scope:pr:") && t !== want);
    return !otherPr;
  }

  if (scope.headBranch) {
    const want = `scope:branch:${scope.headBranch}`;
    if (tags.includes(want)) return true;
    const other = tags.some((t) => t.startsWith("scope:branch:") && t !== want);
    return !other;
  }

  return true;
}

export function fingerprintOfCandidate(
  c: Pick<FindingCandidate, "path" | "category" | "ruleIds" | "body" | "symbolId">,
): string {
  return computeFingerprint({
    path: c.path,
    category: c.category,
    ruleId: c.ruleIds?.[0],
    snippet: c.body?.slice(0, 200),
    symbolId: c.symbolId,
  });
}

/**
 * After a successful review, mark prior active findings as fixed when their
 * fingerprint is absent from the *present* set (findings the model still sees).
 *
 * `presentFingerprints` must come from pre-convergence candidates (verified /
 * after floor), NOT from the noise-stack output that drops "already reported".
 *
 * For incremental reviews, pass `reviewedPaths` so we only auto-fix findings
 * under paths that were actually reviewed.
 */
export async function reconcileFindingsOnRereview(
  store: FindingsStore,
  opts: {
    scope: FindingScope;
    sessionId: string;
    /** Fingerprints still observed in this review (pre prior-convergence). */
    presentFingerprints: Set<string>;
    /**
     * Paths covered by this review. When set, findings outside these paths
     * are left alone (incremental safety).
     */
    reviewedPaths?: string[];
    /** When true, skip auto-fix entirely (failed / aborted sessions). */
    skip?: boolean;
  },
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    fixed: [],
    reopened: [],
    updated: [],
    untouched: 0,
  };
  if (opts.skip) return result;

  const prior = await store.list({
    orgId: opts.scope.orgId,
    repoId: opts.scope.repoId,
  });

  const pathOk = (path: string): boolean => {
    if (!opts.reviewedPaths?.length) return true;
    // Match exact path or prefix (directory units)
    return opts.reviewedPaths.some(
      (p) =>
        p === "." ||
        p === path ||
        path === p ||
        path.startsWith(p.endsWith("/") ? p : `${p}/`) ||
        path.startsWith(p) ||
        p.startsWith(path),
    );
  };

  for (const f of prior) {
    if (!findingMatchesScope(f, opts.scope)) {
      result.untouched++;
      continue;
    }
    if (!ACTIVE.includes(f.status)) {
      result.untouched++;
      continue;
    }
    // Never auto-close findings from this same session
    if (f.sessionId === opts.sessionId) {
      result.untouched++;
      continue;
    }
    if (!pathOk(f.path)) {
      result.untouched++;
      continue;
    }
    if (opts.presentFingerprints.has(f.fingerprint)) {
      result.untouched++;
      continue;
    }

    // Gone from this review → auto-fixed
    if (!canTransition(f.status, "fixed")) {
      result.untouched++;
      continue;
    }
    try {
      assertTransition(f.status, "fixed");
      const tags = [
        ...(f.tags ?? []).filter((t) => !t.startsWith("auto-fixed:")),
        `auto-fixed:${opts.sessionId}`,
        "lifecycle:auto",
      ];
      await store.update(f.id, {
        status: "fixed",
        tags: [...new Set(tags)],
      });
      result.fixed.push(f.id);
    } catch {
      result.untouched++;
    }
  }

  return result;
}

/**
 * Upsert a finding across sessions by fingerprint + scope:
 * - same open fingerprint → refresh body/severity, retarget sessionId
 * - was fixed → reopen if it returned
 * - user-closed (dismissed / FP) → leave closed unless severity rose
 */
export async function upsertFindingAcrossSessions(
  store: FindingsStore,
  candidate: FindingCandidate & { sessionId: string; repoId: string },
  scope: FindingScope,
): Promise<{ finding: Finding; action: "created" | "updated" | "reopened" | "kept_closed" }> {
  const fingerprint = fingerprintOfCandidate(candidate);
  const existing = await store.findByFingerprint(fingerprint, candidate.repoId);

  const scopeTagList = scopeTags(scope);
  const mergeTags = (base: string[] | undefined): string[] =>
    [...new Set([...(base ?? []), ...(candidate.tags ?? []), ...scopeTagList])];

  if (!existing || (existing.orgId ?? "local") !== (candidate.orgId ?? scope.orgId ?? "local")) {
    const created = await store.create({
      ...candidate,
      tags: mergeTags(candidate.tags),
    });
    return { finding: created, action: "created" };
  }

  // Same session merge is handled inside store.create
  if (existing.sessionId === candidate.sessionId) {
    const created = await store.create({
      ...candidate,
      tags: mergeTags(existing.tags),
    });
    return { finding: created, action: "updated" };
  }

  if (USER_CLOSED.includes(existing.status)) {
    const sevUp =
      SEVERITY_RANK[candidate.severity as Severity] >
      SEVERITY_RANK[existing.severity as Severity];
    if (!sevUp) {
      // Keep closed — do not spawn a duplicate open finding
      return { finding: existing, action: "kept_closed" };
    }
    // Severity rose — reopen
    const next = await store.update(existing.id, {
      sessionId: candidate.sessionId,
      status: "reopened",
      title: candidate.title || existing.title,
      body: candidate.body || existing.body,
      severity: candidate.severity,
      confidence: candidate.confidence ?? existing.confidence,
      suggestion: candidate.suggestion ?? existing.suggestion,
      startLine: candidate.startLine ?? existing.startLine,
      endLine: candidate.endLine ?? existing.endLine,
      agents: [...new Set([...(existing.agents ?? []), ...(candidate.agents ?? [])])],
      evidence: [...(existing.evidence ?? []), ...(candidate.evidence ?? [])],
      tags: mergeTags([
        ...(existing.tags ?? []).filter((t) => !t.startsWith("auto-fixed:")),
        "lifecycle:reopened",
      ]),
    });
    return { finding: next, action: "reopened" };
  }

  if (existing.status === "fixed") {
    const next = await store.update(existing.id, {
      sessionId: candidate.sessionId,
      status: "reopened",
      title: candidate.title || existing.title,
      body: candidate.body || existing.body,
      severity: candidate.severity,
      confidence: candidate.confidence ?? existing.confidence,
      suggestion: candidate.suggestion ?? existing.suggestion,
      startLine: candidate.startLine ?? existing.startLine,
      endLine: candidate.endLine ?? existing.endLine,
      agents: [...new Set([...(existing.agents ?? []), ...(candidate.agents ?? [])])],
      evidence: [...(existing.evidence ?? []), ...(candidate.evidence ?? [])],
      tags: mergeTags([
        ...(existing.tags ?? []).filter((t) => !t.startsWith("auto-fixed:")),
        "lifecycle:reopened",
      ]),
    });
    return { finding: next, action: "reopened" };
  }

  // Active finding — refresh content, keep status (or stay reopened)
  const next = await store.update(existing.id, {
    sessionId: candidate.sessionId,
    title: candidate.title || existing.title,
    body: candidate.body || existing.body,
    severity: candidate.severity,
    confidence: candidate.confidence ?? existing.confidence,
    suggestion: candidate.suggestion ?? existing.suggestion,
    startLine: candidate.startLine ?? existing.startLine,
    endLine: candidate.endLine ?? existing.endLine,
    agents: [...new Set([...(existing.agents ?? []), ...(candidate.agents ?? [])])],
    evidence: [...(existing.evidence ?? []), ...(candidate.evidence ?? [])],
    tags: mergeTags([
      ...(existing.tags ?? []),
      `last-seen:${candidate.sessionId}`,
    ]),
    // Keep open/acknowledged/reopened as-is
    status: existing.status,
  });
  return { finding: next, action: "updated" };
}

/** Build present fingerprint set from candidates still visible this review. */
export function presentFingerprintSet(
  candidates: Array<
    Pick<FindingCandidate, "path" | "category" | "ruleIds" | "body" | "symbolId">
  >,
): Set<string> {
  const s = new Set<string>();
  for (const c of candidates) s.add(fingerprintOfCandidate(c));
  return s;
}

export { nowIso };
