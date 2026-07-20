import {
  SEVERITY_RANK,
  computeFingerprint,
  type Finding,
  type FindingCandidate,
  type Severity,
} from "@codesteward/core";
import type { Policy } from "@codesteward/policy";
import { findingEmbedText, matchPreference } from "@codesteward/learning";

export interface NoiseOptions {
  /** Override severity floor (defaults to policy.severityFloor). */
  severityFloor?: Severity;
  /** Max total findings after noise filtering. */
  maxFindings?: number;
  /** Max nits retained. */
  nitCap?: number;
  /** Drop style-only / nitty titles matching these patterns. */
  nitPatterns?: RegExp[];
  /** Max inline comments recommended for SCM publish. */
  commentCap?: number;
  /**
   * Prior fingerprints from previous reviews of the same PR/repo.
   * Used for re-review convergence: suppress already-seen open findings
   * unless severity/confidence increased.
   */
  priorFingerprints?: Map<
    string,
    { severity: Severity; confidence?: number; status?: string }
  >;
  /** Suppress fingerprints present in negative learning memories. */
  suppressedFingerprints?: Set<string>;
  /**
   * Preference prototypes from 👍/👎 (bag-of-words embeddings).
   * Candidates near negative prototypes are dropped; positive is informational only here.
   */
  preferencePrototypes?: Array<{
    polarity: "positive" | "negative";
    embedding: number[];
    fingerprint?: string;
    subjectId: string;
  }>;
  /** When true, drop findings whose title/body looks like pure style nits. */
  filterNits?: boolean;
}

export interface NoiseResult {
  findings: FindingCandidate[];
  dropped: Array<{ title: string; reason: string }>;
  stats: {
    input: number;
    afterFloor: number;
    afterDedupe: number;
    afterNit: number;
    afterPrior: number;
    afterCap: number;
  };
}

const DEFAULT_NIT_PATTERNS = [
  /\btypo\b/i,
  /\bwhitespace\b/i,
  /\btrailing\s+comma\b/i,
  /\bnaming\s+convention\b/i,
  /\bprefer\s+const\b/i,
  /\bmissing\s+semicolon\b/i,
  /\bformat(ting)?\b/i,
  /\bindentation\b/i,
  /\bstyle\s+only\b/i,
  /\bnit:\s*/i,
];

/**
 * Noise stack: severity floor, fingerprint dedupe, nit filter,
 * prior-review convergence, and max caps.
 */
export function applyNoiseStack(
  candidates: FindingCandidate[],
  policy: Policy,
  opts: NoiseOptions = {},
): NoiseResult {
  const dropped: Array<{ title: string; reason: string }> = [];
  const floor = SEVERITY_RANK[opts.severityFloor ?? policy.severityFloor];
  const maxFindings = opts.maxFindings ?? policy.maxFindings;
  const nitCap = opts.nitCap ?? policy.nitCap;
  const filterNits = opts.filterNits ?? true;
  const nitPatterns = opts.nitPatterns ?? DEFAULT_NIT_PATTERNS;
  const prior = opts.priorFingerprints;
  const suppressed = opts.suppressedFingerprints;

  const stats = {
    input: candidates.length,
    afterFloor: 0,
    afterDedupe: 0,
    afterNit: 0,
    afterPrior: 0,
    afterCap: 0,
  };

  // 1. Severity floor + policy ignore + learning suppress
  const afterFloor: FindingCandidate[] = [];
  for (const c of candidates) {
    if (SEVERITY_RANK[c.severity] < floor) {
      dropped.push({ title: c.title, reason: `below severity floor ${opts.severityFloor ?? policy.severityFloor}` });
      continue;
    }
    if (policy.ignoreRules.some((r) => c.ruleIds?.includes(r) || c.title.includes(r))) {
      dropped.push({ title: c.title, reason: "ignored by policy" });
      continue;
    }
    const fp = fingerprintOf(c);
    if (suppressed?.has(fp)) {
      dropped.push({ title: c.title, reason: "suppressed by negative memory" });
      continue;
    }
    if (opts.preferencePrototypes?.length) {
      const pref = matchPreference(
        findingEmbedText({
          title: c.title,
          body: c.body,
          category: c.category,
          path: c.path,
        }),
        opts.preferencePrototypes,
      );
      if (pref.suppress) {
        dropped.push({
          title: c.title,
          reason: `suppressed by preference embedding (sim=${pref.score.toFixed(2)})`,
        });
        continue;
      }
    }
    afterFloor.push(c);
  }
  stats.afterFloor = afterFloor.length;

  // 2. Fingerprint dedupe — keep highest severity/confidence
  const seen = new Map<string, FindingCandidate>();
  for (const c of afterFloor) {
    const fp = fingerprintOf(c);
    const existing = seen.get(fp);
    if (!existing) {
      seen.set(fp, c);
      continue;
    }
    if (
      SEVERITY_RANK[c.severity] > SEVERITY_RANK[existing.severity] ||
      (c.confidence ?? 0) > (existing.confidence ?? 0)
    ) {
      seen.set(fp, {
        ...c,
        agents: [...new Set([...(existing.agents ?? []), ...(c.agents ?? [])])],
        evidence: [...(existing.evidence ?? []), ...(c.evidence ?? [])],
      });
      dropped.push({ title: existing.title, reason: "duplicate fingerprint (kept stronger)" });
    } else {
      dropped.push({ title: c.title, reason: "duplicate fingerprint" });
    }
  }
  let findings = [...seen.values()];
  stats.afterDedupe = findings.length;

  // 3. Nit filter + nit cap (downgrade style-ish lows to nit for capping)
  let nitCount = 0;
  const afterStyle: FindingCandidate[] = findings.map((f) => {
    const looksNitty =
      f.category === "style" ||
      (filterNits && nitPatterns.some((re) => re.test(f.title) || re.test(f.body ?? "")));
    if (
      looksNitty &&
      f.severity !== "nit" &&
      filterNits &&
      SEVERITY_RANK[f.severity] <= SEVERITY_RANK.low
    ) {
      return { ...f, severity: "nit" as const };
    }
    return f;
  });

  findings = afterStyle.filter((f) => {
    const isNit =
      f.severity === "nit" ||
      f.category === "style" ||
      (filterNits && nitPatterns.some((re) => re.test(f.title) || re.test(f.body ?? "")));

    if (f.severity === "nit") {
      nitCount++;
      if (nitCount > nitCap) {
        dropped.push({ title: f.title, reason: "nit cap" });
        return false;
      }
    }

    // Pure style nits at low signal when filter on
    if (
      filterNits &&
      isNit &&
      SEVERITY_RANK[f.severity] <= SEVERITY_RANK.info &&
      nitCount > Math.max(1, Math.floor(nitCap / 2))
    ) {
      dropped.push({ title: f.title, reason: "nit filter" });
      return false;
    }
    return true;
  });
  stats.afterNit = findings.length;

  // 4. Prior fingerprint convergence (re-review)
  if (prior?.size) {
    findings = findings.filter((f) => {
      const fp = fingerprintOf(f);
      const prev = prior.get(fp);
      if (!prev) return true;
      if (prev.status === "fixed" || prev.status === "dismissed" || prev.status === "false_positive") {
        // Re-surface only if severity rose
        if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) return true;
        dropped.push({ title: f.title, reason: "re-review convergence (prior closed)" });
        return false;
      }
      // Still open previously — skip unless confidence/severity increased
      const sevUp = SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity];
      const confUp = (f.confidence ?? 0) > (prev.confidence ?? 0) + 0.15;
      if (sevUp || confUp) return true;
      dropped.push({ title: f.title, reason: "re-review convergence (already reported)" });
      return false;
    });
  }
  stats.afterPrior = findings.length;

  // 5. Sort + max findings cap
  findings = findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  if (findings.length > maxFindings) {
    for (const f of findings.slice(maxFindings)) {
      dropped.push({ title: f.title, reason: "max findings cap" });
    }
    findings = findings.slice(0, maxFindings);
  }
  stats.afterCap = findings.length;

  return { findings, dropped, stats };
}

/** Cap list for SCM inline comments. */
export function capComments<T extends { severity: Severity }>(
  items: T[],
  commentCap = 25,
): T[] {
  return items
    .slice()
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, commentCap);
}

export function fingerprintOf(c: FindingCandidate | Finding): string {
  return computeFingerprint({
    path: c.path,
    category: c.category,
    ruleId: c.ruleIds?.[0],
    snippet: c.body?.slice(0, 200),
    symbolId: c.symbolId,
  });
}

/** Build prior map from historical findings for re-review. */
export function priorMapFromFindings(
  findings: Array<{
    fingerprint: string;
    severity: Severity;
    confidence?: number;
    status?: string;
  }>,
): Map<string, { severity: Severity; confidence?: number; status?: string }> {
  const m = new Map<string, { severity: Severity; confidence?: number; status?: string }>();
  for (const f of findings) {
    const cur = m.get(f.fingerprint);
    if (!cur || SEVERITY_RANK[f.severity] >= SEVERITY_RANK[cur.severity]) {
      m.set(f.fingerprint, {
        severity: f.severity,
        confidence: f.confidence,
        status: f.status,
      });
    }
  }
  return m;
}
