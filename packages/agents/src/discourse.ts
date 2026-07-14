import {
  evidenceId,
  type FindingCandidate,
  type ReviewDepth,
  type RiskTier,
} from "@codesteward/core";
import type { ModelRouter } from "@codesteward/model-router";
import type { GraphClient } from "@codesteward/graph-client";
import type { Policy } from "@codesteward/policy";
import type { ReviewUnit } from "@codesteward/core";
import { extractFindingsFromLlm } from "./extract.js";
import { runSpecialist, type SpecialistContext } from "./specialists.js";

export type DiscourseMove = "AGREE" | "CHALLENGE" | "CONNECT" | "SURFACE";

export interface DiscourseNote {
  move: DiscourseMove;
  targetTitle?: string;
  rationale: string;
  confidence?: number;
}

export interface DiscourseResult {
  /** Merged findings after dual correctness + synthesis */
  findings: FindingCandidate[];
  notes: DiscourseNote[];
  passACount: number;
  passBCount: number;
  droppedByChallenge: number;
  surfacedCount: number;
}

export function shouldRunDiscourse(opts: {
  riskTier?: RiskTier;
  depth?: ReviewDepth;
}): boolean {
  return opts.riskTier === "thorough" || opts.depth === "thorough";
}

/**
 * OCR multiagent-style discourse:
 * 1. Run two independent correctness passes (different temperature / prompt framing)
 * 2. Synthesize with AGREE / CHALLENGE / CONNECT / SURFACE moves
 * 3. Emit merged findings with discourse evidence attached
 */
export async function runDiscourse(
  ctx: {
    sessionId: string;
    repoId: string;
    tenantId: string;
    policy: Policy;
    modelRouter: ModelRouter;
    graph: GraphClient;
    contextText?: string;
    learningGuidance?: string;
    promptPack?: import("./prompt-pack.js").OrgPromptPack | null;
    units: ReviewUnit[];
  },
  existing: FindingCandidate[] = [],
): Promise<DiscourseResult> {
  const unit: ReviewUnit =
    ctx.units[0] ??
    ({
      id: "discourse",
      sessionId: ctx.sessionId,
      kind: "file_batch",
      label: "discourse-all",
      paths: existing.map((f) => f.path).filter(Boolean).slice(0, 40),
      symbols: [],
      status: "running",
      assignedRoles: ["correctness"],
      attempts: 0,
      metadata: {},
    } satisfies ReviewUnit);

  if (!unit.paths.length) {
    unit.paths = ["."];
  }

  const baseCtx: SpecialistContext = {
    sessionId: ctx.sessionId,
    repoId: ctx.repoId,
    tenantId: ctx.tenantId,
    unit: { ...unit, assignedRoles: ["correctness"] },
    policy: ctx.policy,
    modelRouter: ctx.modelRouter,
    graph: ctx.graph,
    contextText: ctx.contextText,
    learningGuidance: ctx.learningGuidance,
    promptPack: ctx.promptPack,
  };

  // Dual independent correctness passes with slightly different framing
  const [passA, passB] = await Promise.all([
    runSpecialist("correctness", {
      ...baseCtx,
      contextText: [
        "PASS A — independent correctness review. Be rigorous about logic bugs.",
        ctx.contextText ?? "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    }),
    runCorrectnessVariant(baseCtx, "B"),
  ]);

  const notes = await synthesizeDiscourse({
    modelRouter: ctx.modelRouter,
    passA,
    passB,
    existing,
    contextText: ctx.contextText,
  });

  return mergeDiscourseFindings({
    passA,
    passB,
    existing,
    notes,
    sessionId: ctx.sessionId,
    repoId: ctx.repoId,
  });
}

async function runCorrectnessVariant(
  ctx: SpecialistContext,
  variant: "B",
): Promise<FindingCandidate[]> {
  const { renderSpecialistSystem, renderSpecialistUser } = await import("./prompt-pack.js");
  const promptVars = {
    severity_floor: String(ctx.policy.severityFloor ?? "medium"),
    path_rules: "",
    org_learning: ctx.learningGuidance ?? "",
    session_id: `${ctx.sessionId} (discourse pass ${variant})`,
    unit_label: ctx.unit.label,
    paths: ctx.unit.paths.map((p) => `- ${p}`).join("\n"),
    context_text: ctx.contextText ? ctx.contextText.slice(0, 16000) : "",
    graph_context: "",
  };
  // Use correctness role template; prepend independent-panelist framing
  const system =
    "You are an independent correctness reviewer (second panelist). Do not assume agreement with any prior review.\n\n" +
    renderSpecialistSystem(ctx.promptPack, "correctness", promptVars);
  const user = renderSpecialistUser(ctx.promptPack, "correctness", promptVars);

  const model = ctx.modelRouter.createChatModel("discourse");
  const res = await model.complete({
    system,
    messages: [{ role: "user", content: user }],
    temperature: 0.35,
    jsonMode: true,
  });
  return extractFindingsFromLlm(res.content, {
    role: "correctness",
    sessionId: ctx.sessionId,
    repoId: ctx.repoId,
  });
}

async function synthesizeDiscourse(input: {
  modelRouter: ModelRouter;
  passA: FindingCandidate[];
  passB: FindingCandidate[];
  existing: FindingCandidate[];
  contextText?: string;
}): Promise<DiscourseNote[]> {
  const model = input.modelRouter.createChatModel("discourse");
  const payload = {
    passA: input.passA.map(compactFinding),
    passB: input.passB.map(compactFinding),
    existing: input.existing.slice(0, 40).map(compactFinding),
  };

  const res = await model.complete({
    system: [
      "You are a discourse synthesizer for multi-agent code review.",
      "Compare two independent correctness passes and existing findings.",
      "Emit moves:",
      "- AGREE: both panels (or existing) support the same issue — boost confidence",
      "- CHALLENGE: a finding is weak, duplicate, or likely false positive — drop or lower",
      "- CONNECT: two findings are related / same root cause — link them",
      "- SURFACE: a novel high-value issue only one panel found — promote it",
      'Reply ONLY JSON: {"notes":[{"move":"AGREE"|"CHALLENGE"|"CONNECT"|"SURFACE","targetTitle":"...","rationale":"...","confidence":0.0-1.0}]}',
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `Findings to synthesize:\n${JSON.stringify(payload, null, 2).slice(0, 14000)}\n\nContext excerpt:\n${(input.contextText ?? "").slice(0, 2000)}`,
      },
    ],
    temperature: 0.2,
    jsonMode: true,
  });

  return parseNotes(res.content);
}

function compactFinding(f: FindingCandidate) {
  return {
    title: f.title,
    path: f.path,
    startLine: f.startLine,
    severity: f.severity,
    category: f.category,
    confidence: f.confidence,
    body: (f.body ?? "").slice(0, 240),
  };
}

function parseNotes(content: string): DiscourseNote[] {
  try {
    const json = peel(content);
    if (!json || typeof json !== "object") return [];
    const notes = (json as { notes?: unknown }).notes;
    if (!Array.isArray(notes)) return [];
    const out: DiscourseNote[] = [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      const move = String((n as { move?: string }).move ?? "").toUpperCase();
      if (!["AGREE", "CHALLENGE", "CONNECT", "SURFACE"].includes(move)) continue;
      out.push({
        move: move as DiscourseMove,
        targetTitle: (n as { targetTitle?: string }).targetTitle,
        rationale: String((n as { rationale?: string }).rationale ?? ""),
        confidence:
          typeof (n as { confidence?: number }).confidence === "number"
            ? (n as { confidence: number }).confidence
            : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function peel(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      /* continue */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function mergeDiscourseFindings(input: {
  passA: FindingCandidate[];
  passB: FindingCandidate[];
  existing: FindingCandidate[];
  notes: DiscourseNote[];
  sessionId: string;
  repoId: string;
}): DiscourseResult {
  const challenged = new Set(
    input.notes
      .filter((n) => n.move === "CHALLENGE" && n.targetTitle)
      .map((n) => normalizeTitle(n.targetTitle!)),
  );
  const agreed = new Map(
    input.notes
      .filter((n) => n.move === "AGREE" && n.targetTitle)
      .map((n) => [normalizeTitle(n.targetTitle!), n] as const),
  );
  const surfaced = new Set(
    input.notes
      .filter((n) => n.move === "SURFACE" && n.targetTitle)
      .map((n) => normalizeTitle(n.targetTitle!)),
  );

  const byKey = new Map<string, FindingCandidate>();
  const keyOf = (f: FindingCandidate) =>
    `${normalizeTitle(f.title)}|${f.path}|${f.startLine ?? ""}`;

  const ingest = (f: FindingCandidate, source: string) => {
    const nt = normalizeTitle(f.title);
    if (challenged.has(nt) && !surfaced.has(nt) && !agreed.has(nt)) {
      return; // challenged and not rescued
    }
    const k = keyOf(f);
    const prev = byKey.get(k);
    const confBoost = agreed.has(nt) ? 0.1 : surfaced.has(nt) ? 0.05 : 0;
    const next: FindingCandidate = {
      ...f,
      confidence: Math.min(1, (f.confidence ?? 0.7) + confBoost),
      agents: [...new Set([...(f.agents ?? []), "discourse" as const, "correctness" as const])],
      evidence: [
        ...(f.evidence ?? []),
        {
          id: evidenceId(),
          type: "discourse" as const,
          summary: `discourse ${source}${agreed.has(nt) ? " AGREE" : ""}${surfaced.has(nt) ? " SURFACE" : ""}`,
          payload: {
            source,
            notes: input.notes.filter(
              (n) => n.targetTitle && normalizeTitle(n.targetTitle) === nt,
            ),
          },
        },
      ],
      sessionId: f.sessionId ?? input.sessionId,
      repoId: f.repoId ?? input.repoId,
    };
    if (!prev) {
      byKey.set(k, next);
      return;
    }
    // Prefer higher severity / confidence; merge agents
    const pick =
      (next.confidence ?? 0) >= (prev.confidence ?? 0) ? next : prev;
    byKey.set(k, {
      ...pick,
      agents: [...new Set([...(prev.agents ?? []), ...(next.agents ?? [])])],
      evidence: [...(prev.evidence ?? []), ...(next.evidence ?? [])],
      body: pick.body || prev.body || next.body,
    });
  };

  for (const f of input.existing) ingest(f, "existing");
  for (const f of input.passA) ingest(f, "passA");
  for (const f of input.passB) ingest(f, "passB");

  // CONNECT notes: tag related findings
  for (const n of input.notes.filter((x) => x.move === "CONNECT")) {
    if (!n.targetTitle) continue;
    const nt = normalizeTitle(n.targetTitle);
    for (const [k, f] of byKey) {
      if (normalizeTitle(f.title) === nt || k.includes(nt.slice(0, 20))) {
        byKey.set(k, {
          ...f,
          tags: [...new Set([...(f.tags ?? []), "discourse-connected"])],
          evidence: [
            ...(f.evidence ?? []),
            {
              id: evidenceId(),
              type: "discourse",
              summary: `CONNECT: ${n.rationale.slice(0, 200)}`,
              payload: { move: "CONNECT", rationale: n.rationale },
            },
          ],
        });
      }
    }
  }

  const findings = [...byKey.values()];
  const droppedByChallenge = Math.max(
    0,
    input.passA.length + input.passB.length + input.existing.length - findings.length,
  );

  return {
    findings,
    notes: input.notes,
    passACount: input.passA.length,
    passBCount: input.passB.length,
    droppedByChallenge,
    surfacedCount: input.notes.filter((n) => n.move === "SURFACE").length,
  };
}
