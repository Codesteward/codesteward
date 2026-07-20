/**
 * Merge-time + human-signal outcome analysis for automatic / indirect eval.
 */
import { createId, nowIso } from "@codesteward/core";
import type {
  FindingOutcome,
  FindingOutcomeKind,
  OutcomeEvalCase,
  PrOutcome,
} from "@codesteward/core";
import { makePrKey } from "./types.js";

export type { FindingOutcome, FindingOutcomeKind, OutcomeEvalCase, PrOutcome };
export { makePrKey };

/** Minimal finding shape for analysis (avoids hard dep on findings package). */
export interface OutcomeFinding {
  id: string;
  sessionId?: string;
  orgId?: string;
  repoId: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  title: string;
  body?: string;
  severity?: string;
  confidence?: number;
  fingerprint: string;
  status: string;
  tags?: string[];
  suggestedFix?: string;
  suggestion?: string;
  createdAt?: string;
}

export interface OutcomeAnalysisInput {
  orgId: string;
  repoId: string;
  prNumber: number;
  mergeSha?: string;
  baseSha?: string;
  headSha?: string;
  pathsChanged: string[];
  patches?: Array<{ path: string; patch?: string }>;
  findings: OutcomeFinding[];
  sessionIds?: string[];
  gateVerdict?: string;
}

export interface OutcomeAnalysisResult {
  pr: PrOutcome;
  findingOutcomes: FindingOutcome[];
  markFixedIds: string[];
  reinforceFingerprints: string[];
  agentMissNotes: Array<{ path: string; note: string }>;
}

const ACTIVE = new Set(["open", "acknowledged", "reopened"]);
const NOISE = new Set(["false_positive", "dismissed"]);
const WONT = new Set(["wontfix"]);
const FIXED = new Set(["fixed"]);

const FN_PATH_HINT =
  /(auth|security|password|secret|crypto|sql|inject|xss|csrf|permission|rbac|token|oauth|sast|cve|vuln)/i;

/**
 * Analyze PR merge: classify each finding and mine agent-miss candidates.
 */
export function analyzePrMerge(input: OutcomeAnalysisInput): OutcomeAnalysisResult {
  const prKey = makePrKey(input.repoId, input.prNumber);
  const ts = nowIso();
  const changed = new Set(input.pathsChanged.map(normalizePath));
  const patchByPath = new Map(
    (input.patches ?? []).map((p) => [normalizePath(p.path), p.patch ?? ""]),
  );

  const findingOutcomes: FindingOutcome[] = [];
  const markFixedIds: string[] = [];
  const reinforceFingerprints: string[] = [];

  let posted = 0;
  let accepted = 0;
  let fixed = 0;
  let thumbsUp = 0;
  let falsePositive = 0;
  let dismissed = 0;
  let unaddressedAtMerge = 0;

  const scoped = input.findings.filter((f) =>
    isFindingForPr(f, input.prNumber, input.repoId),
  );

  for (const f of scoped) {
    posted++;
    const tags = f.tags ?? [];
    const path = normalizePath(f.path ?? "");
    const pathTouched =
      Boolean(path) &&
      (changed.has(path) ||
        [...changed].some((c) => pathEndsWith(c, path) || pathEndsWith(path, c)));

    let kind: FindingOutcomeKind | undefined;
    let confidence = 0.7;
    let note: string | undefined;

    if (FIXED.has(f.status) || tags.some((t) => t.startsWith("auto-fixed:"))) {
      kind = "fixed";
      fixed++;
      confidence = 1;
    } else if (f.status === "false_positive" || tags.includes("reaction:down")) {
      kind = "false_positive";
      falsePositive++;
      confidence = 1;
    } else if (NOISE.has(f.status) || WONT.has(f.status)) {
      kind = "dismissed";
      dismissed++;
      confidence = 1;
    } else if (tags.includes("reaction:up")) {
      kind = "thumbs_up";
      thumbsUp++;
      confidence = 1;
      reinforceFingerprints.push(f.fingerprint);
    } else if (ACTIVE.has(f.status)) {
      const fixText = f.suggestedFix || f.suggestion || "";
      const patch = path ? (patchByPath.get(path) ?? "") : "";
      const applyScore = fixText && patch ? suggestionApplyScore(fixText, patch) : 0;
      if (applyScore >= 0.35) {
        kind = "accepted";
        accepted++;
        confidence = Math.min(0.95, 0.5 + applyScore);
        note = `suggestion-apply score=${applyScore.toFixed(2)}`;
        markFixedIds.push(f.id);
        reinforceFingerprints.push(f.fingerprint);
      } else if (pathTouched) {
        kind = "fixed";
        fixed++;
        confidence = 0.65;
        note = "path changed at merge; treating as fixed";
        markFixedIds.push(f.id);
        reinforceFingerprints.push(f.fingerprint);
      } else {
        kind = "unaddressed_at_merge";
        unaddressedAtMerge++;
        confidence = 0.8;
        note = "still open; path not changed at merge";
      }
    }

    if (kind) {
      findingOutcomes.push({
        id: createId("fout"),
        orgId: input.orgId,
        repoId: input.repoId,
        prNumber: input.prNumber,
        prKey,
        findingId: f.id,
        fingerprint: f.fingerprint,
        kind,
        sessionId: f.sessionId,
        mergeSha: input.mergeSha,
        confidence,
        note,
        metadata: { status: f.status, severity: f.severity, path: f.path },
        createdAt: ts,
      });
    }
  }

  const agentMissNotes: Array<{ path: string; note: string }> = [];
  const foundPaths = new Set(
    scoped.map((f) => normalizePath(f.path ?? "")).filter(Boolean),
  );
  for (const p of changed) {
    if (!FN_PATH_HINT.test(p)) continue;
    if ([...foundPaths].some((fp) => pathEndsWith(fp, p) || pathEndsWith(p, fp))) {
      continue;
    }
    agentMissNotes.push({
      path: p,
      note: `Sensitive path changed at merge with no Codesteward finding: ${p}`,
    });
    findingOutcomes.push({
      id: createId("fout"),
      orgId: input.orgId,
      repoId: input.repoId,
      prNumber: input.prNumber,
      prKey,
      kind: "agent_miss_candidate",
      mergeSha: input.mergeSha,
      confidence: 0.4,
      note: `No finding on changed sensitive path ${p}`,
      metadata: { path: p },
      createdAt: ts,
    });
  }

  const gate = (input.gateVerdict ?? "").toLowerCase();
  const criticalOpen = scoped.filter(
    (f) =>
      ACTIVE.has(f.status) &&
      (f.severity === "critical" || f.severity === "high"),
  );
  if ((gate.includes("approve") || gate === "success") && criticalOpen.length) {
    for (const f of criticalOpen.slice(0, 5)) {
      findingOutcomes.push({
        id: createId("fout"),
        orgId: input.orgId,
        repoId: input.repoId,
        prNumber: input.prNumber,
        prKey,
        findingId: f.id,
        fingerprint: f.fingerprint,
        kind: "gate_regret_miss",
        mergeSha: input.mergeSha,
        confidence: 0.75,
        note: `Gate ${input.gateVerdict} but ${f.severity} finding still open`,
        createdAt: ts,
      });
    }
  }
  if (
    (gate.includes("request_changes") ||
      gate.includes("changes_requested") ||
      gate === "failure") &&
    scoped.length > 0 &&
    scoped.every(
      (f) =>
        f.severity === "nit" ||
        f.severity === "info" ||
        f.severity === "low" ||
        NOISE.has(f.status) ||
        (f.tags ?? []).includes("reaction:down"),
    )
  ) {
    findingOutcomes.push({
      id: createId("fout"),
      orgId: input.orgId,
      repoId: input.repoId,
      prNumber: input.prNumber,
      prKey,
      kind: "gate_regret_noise",
      mergeSha: input.mergeSha,
      confidence: 0.6,
      note: "Gate blocked PR but only low/noise findings",
      createdAt: ts,
    });
  }

  const fixAccept = accepted + fixed + thumbsUp;
  const noise = falsePositive + dismissed;
  const rates = {
    fixAcceptRate: posted === 0 ? null : fixAccept / posted,
    noiseRate: posted === 0 ? null : noise / posted,
    ignoreAtMergeRate: posted === 0 ? null : unaddressedAtMerge / posted,
  };

  const pr: PrOutcome = {
    id: createId("pout"),
    orgId: input.orgId,
    repoId: input.repoId,
    prNumber: input.prNumber,
    prKey,
    mergeSha: input.mergeSha,
    baseSha: input.baseSha,
    headSha: input.headSha,
    sessionIds: input.sessionIds ?? [
      ...new Set(scoped.map((f) => f.sessionId).filter(Boolean) as string[]),
    ],
    gateVerdict: input.gateVerdict,
    counts: {
      posted,
      accepted,
      fixed,
      thumbsUp,
      falsePositive,
      dismissed,
      unaddressedAtMerge,
      agentMissCandidates: agentMissNotes.length,
    },
    rates,
    pathsChanged: input.pathsChanged,
    metadata: {},
    createdAt: ts,
  };

  return {
    pr,
    findingOutcomes,
    markFixedIds: [...new Set(markFixedIds)],
    reinforceFingerprints: [...new Set(reinforceFingerprints)],
    agentMissNotes,
  };
}

export function isFindingForPr(
  f: OutcomeFinding,
  prNumber: number,
  repoId: string,
): boolean {
  if (f.repoId !== repoId) return false;
  const tags = f.tags ?? [];
  if (tags.includes(`scope:pr:${prNumber}`)) return true;
  const hasOtherPr = tags.some(
    (t) => t.startsWith("scope:pr:") && t !== `scope:pr:${prNumber}`,
  );
  if (hasOtherPr) return false;
  return tags.some((t) => t.startsWith("scope:pr:"))
    ? tags.includes(`scope:pr:${prNumber}`)
    : true;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathEndsWith(a: string, b: string): boolean {
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

export function suggestionApplyScore(suggestion: string, patch: string): number {
  const a = tokenize(suggestion);
  const b = tokenize(patch);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.max(a.size, Math.min(b.size, a.size * 2));
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2),
  );
}

export function outcomesToEvalCases(
  outcomes: FindingOutcome[],
  findingsById?: Map<string, OutcomeFinding>,
): OutcomeEvalCase[] {
  const cases: OutcomeEvalCase[] = [];
  for (const o of outcomes) {
    const f = o.findingId ? findingsById?.get(o.findingId) : undefined;
    if (o.kind === "false_positive" || o.kind === "dismissed") {
      cases.push({
        id: o.id,
        source: o.kind === "false_positive" ? "reaction" : "status",
        expected: { should_fire: false },
        predicted: { fired: true, line_correct: true },
        fingerprint: o.fingerprint,
        path: f?.path,
        title: f?.title,
        severity: f?.severity,
        confidence: f?.confidence,
        outcomeKind: o.kind,
        orgId: o.orgId,
        repoId: o.repoId,
        prNumber: o.prNumber,
      });
    } else if (
      o.kind === "accepted" ||
      o.kind === "fixed" ||
      o.kind === "thumbs_up"
    ) {
      cases.push({
        id: o.id,
        source: o.kind === "thumbs_up" ? "reaction" : "merge",
        expected: { should_fire: true, line_correct: true },
        predicted: { fired: true, line_correct: true },
        fingerprint: o.fingerprint,
        path: f?.path,
        title: f?.title,
        severity: f?.severity,
        confidence: f?.confidence,
        outcomeKind: o.kind,
        orgId: o.orgId,
        repoId: o.repoId,
        prNumber: o.prNumber,
      });
    } else if (o.kind === "agent_miss_candidate" || o.kind === "security_advisory") {
      cases.push({
        id: o.id,
        source: "fn_candidate",
        expected: { should_fire: true },
        predicted: { fired: false },
        path: (o.metadata?.path as string) ?? undefined,
        outcomeKind: o.kind,
        orgId: o.orgId,
        repoId: o.repoId,
        prNumber: o.prNumber,
      });
    } else if (o.kind === "thread_resolved") {
      cases.push({
        id: o.id,
        source: "merge",
        expected: { should_fire: true, line_correct: true },
        predicted: { fired: true, line_correct: true },
        fingerprint: o.fingerprint,
        path: f?.path,
        title: f?.title,
        severity: f?.severity,
        confidence: f?.confidence,
        outcomeKind: o.kind,
        orgId: o.orgId,
        repoId: o.repoId,
        prNumber: o.prNumber,
      });
    } else if (o.kind === "unaddressed_at_merge") {
      cases.push({
        id: o.id,
        source: "merge",
        expected: { should_fire: true },
        predicted: { fired: true },
        fingerprint: o.fingerprint,
        path: f?.path,
        title: f?.title,
        severity: f?.severity,
        confidence: f?.confidence,
        outcomeKind: o.kind,
        orgId: o.orgId,
        repoId: o.repoId,
        prNumber: o.prNumber,
      });
    }
  }
  return cases;
}

/** Aggregate org-level quality KPIs (fix/accept vs noise vs open). */
export function computeQualityKpis(input: {
  findings: OutcomeFinding[];
  outcomes?: FindingOutcome[];
  windowDays?: number;
}): {
  considered: number;
  fixAccept: number;
  noise: number;
  open: number;
  fixAcceptRate: number | null;
  noiseRate: number | null;
  openRate: number | null;
  confidenceCalibration: Array<{
    bucket: string;
    n: number;
    laterNoiseRate: number | null;
    laterFixRate: number | null;
  }>;
  definition: string;
} {
  const findings = input.findings;
  const considered = findings.length;
  let fixAccept = 0;
  let noise = 0;
  let open = 0;
  for (const f of findings) {
    const tags = f.tags ?? [];
    if (
      FIXED.has(f.status) ||
      tags.includes("reaction:up") ||
      tags.some((t) => t.startsWith("auto-fixed:"))
    ) {
      fixAccept++;
    } else if (
      f.status === "false_positive" ||
      tags.includes("reaction:down") ||
      NOISE.has(f.status) ||
      WONT.has(f.status)
    ) {
      noise++;
    } else if (ACTIVE.has(f.status)) {
      open++;
    }
  }

  const buckets = [
    { name: "0.0-0.4", lo: 0, hi: 0.4 },
    { name: "0.4-0.7", lo: 0.4, hi: 0.7 },
    { name: "0.7-1.0", lo: 0.7, hi: 1.01 },
  ];
  const outcomeByFp = new Map<string, FindingOutcomeKind>();
  for (const o of input.outcomes ?? []) {
    if (o.fingerprint) outcomeByFp.set(o.fingerprint, o.kind);
  }
  const confidenceCalibration = buckets.map((b) => {
    const inB = findings.filter((f) => {
      const c = f.confidence ?? 0.5;
      return c >= b.lo && c < b.hi;
    });
    let nNoise = 0;
    let nFix = 0;
    for (const f of inB) {
      const k = outcomeByFp.get(f.fingerprint);
      const tags = f.tags ?? [];
      if (
        k === "false_positive" ||
        k === "dismissed" ||
        f.status === "false_positive" ||
        tags.includes("reaction:down")
      ) {
        nNoise++;
      }
      if (
        k === "accepted" ||
        k === "fixed" ||
        k === "thumbs_up" ||
        FIXED.has(f.status) ||
        tags.includes("reaction:up")
      ) {
        nFix++;
      }
    }
    return {
      bucket: b.name,
      n: inB.length,
      laterNoiseRate: inB.length ? nNoise / inB.length : null,
      laterFixRate: inB.length ? nFix / inB.length : null,
    };
  });

  return {
    considered,
    fixAccept,
    noise,
    open,
    fixAcceptRate: considered ? fixAccept / considered : null,
    noiseRate: considered ? noise / considered : null,
    openRate: considered ? open / considered : null,
    confidenceCalibration,
    definition:
      "fixAccept = fixed|auto-fixed|thumbs_up; noise = false_positive|dismissed|wontfix|thumbs_down; open = still active. Prefer fixAcceptRate as address-rate north star (not FP-inflated).",
  };
}
