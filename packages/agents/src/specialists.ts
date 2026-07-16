import { type AgentRole, type FindingCandidate, type ReviewUnit } from "@codesteward/core";
import type { GraphClient } from "@codesteward/graph-client";
import { resolveModelForRole, type ModelRouter } from "@codesteward/model-router";
import type { Policy } from "@codesteward/policy";
import { applyProductConfidence } from "./confidence.js";
import {
  extractFindingsFromLlm,
  resolveSpecialistRunConfidence,
} from "./extract.js";
import type { SessionAuditCollector } from "./session-audit.js";
import {
  DEFAULT_PERSONAS,
  type OrgPromptPack,
  renderSpecialistSystem,
  renderSpecialistUser,
} from "./prompt-pack.js";

export interface SpecialistContext {
  sessionId: string;
  repoId: string;
  tenantId: string;
  /** Product org (multi-tenant isolation); defaults to tenantId when unset */
  orgId?: string;
  unit: ReviewUnit;
  policy: Policy;
  modelRouter: ModelRouter;
  graph: GraphClient;
  /** Optional diff or file excerpts. */
  contextText?: string;
  /**
   * Org-scoped learning guidance (reactions, dismissals, preferences).
   * Injected into the system prompt so the model steers away from known noise.
   */
  learningGuidance?: string;
  /** Org prompt pack (editable personas / instructions). */
  promptPack?: OrgPromptPack | null;
  /** Optional run forensics collector */
  audit?: SessionAuditCollector;
  /** simple | deepagents */
  runnerKind?: "simple" | "deepagents" | "unknown";
  /** Optional progress event sink (for specialist_run SSE) */
  onEvent?: (event: import("@codesteward/core").ProgressEvent) => void | Promise<void>;
}

/** @deprecated Prefer org prompt pack personas — kept for callers/tests. */
export const SPECIALIST_PROMPTS: Partial<Record<AgentRole, string>> = {
  ...DEFAULT_PERSONAS,
};

export async function runSpecialist(
  role: AgentRole,
  ctx: SpecialistContext,
): Promise<FindingCandidate[]> {
  let modelLabel: string | undefined;
  try {
    const target = resolveModelForRole(role as never, ctx.modelRouter.getConfig());
    modelLabel = `${target.provider}:${target.model}`;
  } catch {
    modelLabel = undefined;
  }

  const filesFromContext =
    ctx.contextText
      ?.match(/^### FILE: (.+)$/gm)
      ?.map((l) => l.replace(/^### FILE:\s*/, "").trim())
      .filter(Boolean) ?? [];
  const runId = ctx.audit?.startRun({
    unitId: ctx.unit.id,
    unitLabel: ctx.unit.label,
    role,
    runner: ctx.runnerKind ?? "simple",
    model: modelLabel,
    pathsReviewed: ctx.unit.paths,
    filesReviewed: filesFromContext.length ? filesFromContext : undefined,
  });

  const { emitSpecialistProgress, startSpecialistHeartbeat } = await import(
    "./specialist-progress.js"
  );
  const startedAtMs = Date.now();
  emitSpecialistProgress(ctx.onEvent, {
    sessionId: ctx.sessionId,
    unitId: ctx.unit.id,
    unitLabel: ctx.unit.label,
    role,
    status: "started",
    model: modelLabel,
    runner: ctx.runnerKind ?? "simple",
  });
  const stopHeartbeat = startSpecialistHeartbeat({
    onEvent: ctx.onEvent,
    sessionId: ctx.sessionId,
    unitId: ctx.unit.id,
    unitLabel: ctx.unit.label,
    role,
    model: modelLabel,
    runner: ctx.runnerKind ?? "simple",
    startedAtMs,
  });

  let toolCalls = 0;
  // Graph grounding — multi-path structural context for security / correctness / evidence
  let graphContext = "";
  const graphEvidencePayload: {
    queries: Array<Record<string, unknown>>;
  } = { queries: [] };
  if (role === "security" || role === "correctness" || role === "evidence") {
    try {
      const basenames = [
        ...new Set(
          ctx.unit.paths
            .slice(0, 5)
            .map((p) => p.split("/").pop() ?? p)
            .filter(Boolean),
        ),
      ];
      const chunks: string[] = [];
      for (const q of basenames.slice(0, 3)) {
        const t0 = Date.now();
        const { graphTenantId } = await import("./graph-scope.js");
        const gTenant = graphTenantId(ctx.orgId, ctx.tenantId);
        const lexical = await ctx.graph.query("lexical", q, {
          tenantId: gTenant,
          repoId: ctx.repoId,
          limit: 15,
        });
        const referential = await ctx.graph.query("referential", q, {
          tenantId: gTenant,
          repoId: ctx.repoId,
          limit: 15,
        });
        toolCalls += 2;
        ctx.audit?.recordTool({
          unitId: ctx.unit.id,
          role,
          tool: "graph_query",
          name: "codebase_graph_query",
          summary: `lexical+referential q=${q} totals=${lexical.total}/${referential.total}`,
          ok: true,
          durationMs: Date.now() - t0,
          detail: {
            query: q,
            lexicalTotal: lexical.total,
            referentialTotal: referential.total,
          },
        });
        graphEvidencePayload.queries.push({
          query: q,
          lexicalTotal: lexical.total,
          referentialTotal: referential.total,
          lexical: lexical.results.slice(0, 8),
          referential: referential.results.slice(0, 8),
        });
        chunks.push(
          `## ${q}\nlexical=${lexical.total} referential=${referential.total}\n${JSON.stringify(
            {
              lexical: lexical.results.slice(0, 6),
              referential: referential.results.slice(0, 6),
            },
            null,
            2,
          )}`,
        );
      }
      graphContext = chunks.join("\n\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      graphContext = `Graph unavailable: ${msg}`;
      ctx.audit?.recordTool({
        unitId: ctx.unit.id,
        role,
        tool: "graph_query",
        name: "codebase_graph_query",
        summary: `graph failed: ${msg.slice(0, 200)}`,
        ok: false,
      });
    }
  }

  const rulesForPaths = ctx.policy.pathRules
    .filter((r) => ctx.unit.paths.some((p) => p.includes(r.pathScope.replace("/**", ""))))
    .map((r) => `- [${r.id}] ${r.pathScope}: ${r.title ?? ""}\n${r.guidance.slice(0, 500)}`)
    .join("\n");

  const promptVars = {
    severity_floor: String(ctx.policy.severityFloor ?? "medium"),
    path_rules: rulesForPaths,
    org_learning: ctx.learningGuidance ?? "",
    session_id: ctx.sessionId,
    unit_label: ctx.unit.label,
    paths: ctx.unit.paths.map((p) => `- ${p}`).join("\n"),
    context_text: ctx.contextText ? ctx.contextText.slice(0, 16000) : "",
    graph_context: graphContext ? graphContext.slice(0, 6000) : "",
  };
  const deep = ctx.runnerKind === "deepagents";
  const system = renderSpecialistSystem(ctx.promptPack, role, promptVars, { deep });
  const user = renderSpecialistUser(ctx.promptPack, role, promptVars);

  const promptChars = system.length + user.length;

  try {
    const model = ctx.modelRouter.createChatModel(role);
    const res = await model.complete({
      system,
      messages: [{ role: "user", content: user }],
      jsonMode: true,
      temperature: 0.1,
    });

    let findings = extractFindingsFromLlm(res.content, {
      role,
      sessionId: ctx.sessionId,
      repoId: ctx.repoId,
      tokenConfidence: res.tokenConfidence,
    });

    // Attach structured graph evidence to high-severity findings, then rescore product confidence
    if (graphEvidencePayload.queries.length) {
      findings = findings.map((f) => {
        const sev = String(f.severity ?? "medium");
        if (
          ["critical", "high", "medium"].includes(sev) ||
          role === "evidence" ||
          role === "security"
        ) {
          const existing = Array.isArray(f.evidence) ? f.evidence : [];
          const withEv = {
            ...f,
            // Keep specialist reasoning; only append graph grounding
            reasoning: f.reasoning,
            evidence: [
              ...existing,
              {
                type: "graph" as const,
                id: `graph-${role}-${ctx.unit.id}`,
                summary: `Structural graph queries for ${ctx.unit.paths.slice(0, 3).join(", ")}`,
                payload: graphEvidencePayload,
              },
            ],
          };
          return applyProductConfidence(withEv);
        }
        return f;
      });
    }

    if (runId && ctx.audit) {
      const usedGraph = graphEvidencePayload.queries.length > 0;
      const runConf = resolveSpecialistRunConfidence({
        findings,
        responseContent: res.content ?? "",
        tokenConfidence: res.tokenConfidence,
        pathsReviewed: ctx.unit.paths.length,
        filesReviewed: filesFromContext.length,
        usedGraph,
      });
      const findingsSummary =
        findings.length > 0
          ? findings.map((f) => ({
              title: f.title,
              severity: f.severity,
              confidence: f.confidence,
              modelConfidence: f.modelConfidence,
              tokenConfidence: f.tokenConfidence,
              path: f.path,
              startLine: f.startLine,
              category: f.category,
            }))
          : [
              {
                title: "No findings",
                severity: "info",
                confidence: runConf.avgConfidence,
                modelConfidence: runConf.modelEmptyScanConfidence,
                tokenConfidence: res.tokenConfidence,
                category: "other",
              },
            ];
      ctx.audit.endRun(runId, {
        status: "ok",
        findingCount: findings.length,
        responseContent: res.content ?? "",
        promptChars,
        toolCallCount: toolCalls,
        usedGraph,
        filesReviewed: filesFromContext.length ? filesFromContext : undefined,
        pathsReviewed: ctx.unit.paths,
        avgConfidence: runConf.avgConfidence,
        findingsSummary,
      });
    }
    stopHeartbeat();
    emitSpecialistProgress(ctx.onEvent, {
      sessionId: ctx.sessionId,
      unitId: ctx.unit.id,
      unitLabel: ctx.unit.label,
      role,
      status: "completed",
      model: modelLabel,
      runner: ctx.runnerKind ?? "simple",
      findingCount: findings.length,
      durationMs: Date.now() - startedAtMs,
    });
    return findings;
  } catch (err) {
    stopHeartbeat();
    const msg = err instanceof Error ? err.message : String(err);
    if (runId && ctx.audit) {
      ctx.audit.endRun(runId, {
        status: "error",
        findingCount: 0,
        error: msg,
        promptChars,
        toolCallCount: toolCalls,
      });
    }
    emitSpecialistProgress(ctx.onEvent, {
      sessionId: ctx.sessionId,
      unitId: ctx.unit.id,
      unitLabel: ctx.unit.label,
      role,
      status: "failed",
      model: modelLabel,
      runner: ctx.runnerKind ?? "simple",
      error: msg,
      durationMs: Date.now() - startedAtMs,
    });
    throw err;
  }
}
