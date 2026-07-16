import {
  CategorySchema,
  SeveritySchema,
  type AgentRole,
  type FindingCandidate,
} from "@codesteward/core";
import { z } from "zod";
import {
  applyProductConfidence,
  scoreEmptyScanConfidence,
} from "./confidence.js";

const LlmFindingSchema = z
  .object({
    title: z.union([z.string().min(1), z.number()]).transform(String),
    body: z.union([z.string(), z.number()]).optional().transform((v) =>
      v == null ? undefined : String(v),
    ),
    description: z.union([z.string(), z.number()]).optional().transform((v) =>
      v == null ? undefined : String(v),
    ),
    path: z.union([z.string(), z.number()]).optional().transform((v) =>
      v == null ? undefined : String(v),
    ),
    file: z.union([z.string(), z.number()]).optional().transform((v) =>
      v == null ? undefined : String(v),
    ),
    filepath: z.string().optional(),
    filePath: z.string().optional(),
    filename: z.string().optional(),
    startLine: z.union([z.number(), z.string()]).optional(),
    endLine: z.union([z.number(), z.string()]).optional(),
    line: z.union([z.number(), z.string()]).optional(),
    symbolId: z.string().optional(),
    category: z.union([CategorySchema, z.string()]).optional(),
    severity: z.union([SeveritySchema, z.string()]).optional(),
    // Models often return 0–100 or strings (self-report → modelConfidence)
    confidence: z.union([z.number(), z.string()]).optional(),
    modelConfidence: z.union([z.number(), z.string()]).optional(),
    suggestion: z.string().optional(),
    suggestedFix: z.string().optional(),
    suggested_fix: z.string().optional(),
    fix: z.string().optional(),
    codeFix: z.string().optional(),
    code_fix: z.string().optional(),
    existingCode: z.string().optional(),
    existing_code: z.string().optional(),
    reasoning: z.string().optional(),
    rationale: z.string().optional(),
    analysis: z.string().optional(),
    thought: z.string().optional(),
    ruleIds: z
      .union([z.array(z.union([z.string(), z.number()])), z.string()])
      .optional(),
  })
  .passthrough();

function asLine(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function asConfidence(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizeFinding(raw: unknown): {
  title: string;
  body: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  category: string;
  severity: string;
  /** Specialist self-report only — maps to modelConfidence */
  modelConfidence?: number;
  suggestion?: string;
  suggestedFix?: string;
  existingCode?: string;
  reasoning?: string;
  ruleIds?: string[];
} | null {
  // Extremely defensive: if Zod is still picky, accept plain objects with a title
  const parsed = LlmFindingSchema.safeParse(raw);
  if (!parsed.success) {
    if (raw && typeof raw === "object" && "title" in raw) {
      const o = raw as Record<string, unknown>;
      const title = String(o.title ?? "").trim();
      if (!title) return null;
      const path = String(
        o.path ?? o.file ?? o.filepath ?? o.filePath ?? o.filename ?? "unknown",
      );
      const cat = CategorySchema.safeParse(o.category);
      const sev = SeveritySchema.safeParse(
        typeof o.severity === "string" ? o.severity.toLowerCase() : o.severity,
      );
      return {
        title,
        body: String(o.body ?? o.description ?? ""),
        path: path || "unknown",
        startLine: asLine(o.startLine) ?? asLine(o.line),
        endLine: asLine(o.endLine) ?? asLine(o.startLine) ?? asLine(o.line),
        symbolId: typeof o.symbolId === "string" ? o.symbolId : undefined,
        category: cat.success ? cat.data : "other",
        severity: sev.success ? sev.data : "medium",
        modelConfidence: asConfidence(o.modelConfidence ?? o.confidence),
        suggestion: typeof o.suggestion === "string" ? o.suggestion : undefined,
        suggestedFix: pickString(
          o.suggestedFix,
          o.suggested_fix,
          o.fix,
          o.codeFix,
          o.code_fix,
        ),
        existingCode: pickString(o.existingCode, o.existing_code),
        reasoning: pickString(o.reasoning, o.rationale, o.analysis, o.thought),
        ruleIds: Array.isArray(o.ruleIds)
          ? o.ruleIds.map(String)
          : typeof o.ruleIds === "string"
            ? [o.ruleIds]
            : undefined,
      };
    }
    if (process.env.STEW_DEBUG_LLM === "1") {
      console.warn(
        `[extract] normalize reject: ${parsed.error.issues.map((i) => i.path.join(".") + ":" + i.message).join("; ").slice(0, 200)}`,
      );
    }
    return null;
  }
  const f = parsed.data;
  const path =
    f.path || f.file || f.filepath || f.filePath || f.filename || "unknown";
  const cat = CategorySchema.safeParse(f.category);
  const sev = SeveritySchema.safeParse(
    typeof f.severity === "string" ? f.severity.toLowerCase() : f.severity,
  );
  const ruleIds = Array.isArray(f.ruleIds)
    ? f.ruleIds.map(String)
    : typeof f.ruleIds === "string"
      ? [f.ruleIds]
      : undefined;
  return {
    title: f.title,
    body: f.body ?? f.description ?? "",
    path,
    startLine: asLine(f.startLine) ?? asLine(f.line),
    endLine: asLine(f.endLine) ?? asLine(f.startLine) ?? asLine(f.line),
    symbolId: f.symbolId,
    category: cat.success ? cat.data : "other",
    severity: sev.success ? sev.data : "medium",
    modelConfidence: asConfidence(f.modelConfidence ?? f.confidence),
    suggestion: f.suggestion,
    suggestedFix: pickString(
      f.suggestedFix,
      f.suggested_fix,
      f.fix,
      f.codeFix,
      f.code_fix,
    ),
    existingCode: pickString(f.existingCode, f.existing_code),
    reasoning: pickString(f.reasoning, f.rationale, f.analysis, f.thought),
    ruleIds,
  };
}

/**
 * Platform runtime: STEW_SUGGESTED_FIX_MIN_CONFIDENCE (0–1, default 0.75).
 * Below this, suggestedFix is dropped (plain suggestion kept).
 */
export function getSuggestedFixMinConfidence(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STEW_SUGGESTED_FIX_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") return 0.75;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.75;
  return Math.min(1, Math.max(0, n));
}

/**
 * Drop concrete code fixes when confidence is below the platform threshold.
 * Safe to call anytime findings are merged or published.
 */
export function applySuggestedFixConfidenceGate<
  T extends { confidence?: number; suggestedFix?: string },
>(findings: T[], env: NodeJS.ProcessEnv = process.env): T[] {
  const min = getSuggestedFixMinConfidence(env);
  return findings.map((f) => {
    if (!f.suggestedFix?.trim()) return f;
    const conf = f.confidence ?? 0.7;
    if (conf + 1e-9 >= min) return f;
    return { ...f, suggestedFix: undefined };
  });
}

export type ExtractLlmOptions = {
  role: AgentRole;
  sessionId?: string;
  repoId?: string;
  /** Completion-level mean token probability (from provider logprobs), when available. */
  tokenConfidence?: number;
};

/**
 * When findings is empty, parse specialist self-report that nothing was missed.
 * Accepts emptyScanConfidence | empty_scan_confidence | confidence | scanConfidence.
 */
export function extractEmptyScanModelConfidence(
  content: string,
): number | undefined {
  const json = peelJson(content);
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;
  const arr = obj.findings ?? obj.issues ?? obj.results;
  // Only treat top-level confidence as empty-scan when there are no findings
  if (Array.isArray(arr) && arr.length > 0) return undefined;
  return asConfidence(
    obj.emptyScanConfidence ??
      obj.empty_scan_confidence ??
      obj.scanConfidence ??
      obj.scan_confidence ??
      obj.confidence,
  );
}

export function resolveSpecialistRunConfidence(input: {
  findings: Array<{ confidence?: number }>;
  responseContent?: string;
  tokenConfidence?: number;
  pathsReviewed?: number;
  filesReviewed?: number;
  usedGraph?: boolean;
}): {
  avgConfidence: number;
  modelEmptyScanConfidence?: number;
  emptyScan: boolean;
} {
  const confs = input.findings
    .map((f) => f.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (confs.length > 0) {
    return {
      avgConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
      emptyScan: false,
    };
  }
  const modelEmpty = extractEmptyScanModelConfidence(input.responseContent ?? "");
  const validEmptyJson = Boolean(peelJson(input.responseContent ?? ""));
  return {
    avgConfidence: scoreEmptyScanConfidence({
      modelConfidence: modelEmpty,
      tokenConfidence: input.tokenConfidence,
      pathsReviewed: input.pathsReviewed,
      filesReviewed: input.filesReviewed,
      usedGraph: input.usedGraph,
      validEmptyJson,
    }),
    modelEmptyScanConfidence: modelEmpty,
    emptyScan: true,
  };
}

/** Extract structured findings from LLM JSON (or fenced / noisy tool output). */
export function extractFindingsFromLlm(
  content: string,
  ctx: ExtractLlmOptions,
): FindingCandidate[] {
  if (!content || !String(content).trim()) return [];
  const json = peelJson(content);
  if (!json) {
    if (process.env.STEW_DEBUG_LLM === "1") {
      console.warn(
        `[extract] peelJson failed role=${ctx.role} chars=${content.length} head=${content.slice(0, 200)}`,
      );
    }
    return [];
  }

  // Prefer { findings: [...] }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const arr = obj.findings ?? obj.issues ?? obj.results;
    if (Array.isArray(arr)) {
      const out: FindingCandidate[] = [];
      for (const item of arr) {
        const n = normalizeFinding(item);
        if (n) out.push(toCandidate(n, ctx));
      }
      if (process.env.STEW_DEBUG_LLM === "1") {
        console.warn(
          `[extract] role=${ctx.role} items=${arr.length} accepted=${out.length}`,
        );
      }
      return applySuggestedFixConfidenceGate(out);
    }
    // single finding object
    const one = normalizeFinding(json);
    if (one) return applySuggestedFixConfidenceGate([toCandidate(one, ctx)]);
  }

  if (Array.isArray(json)) {
    const out: FindingCandidate[] = [];
    for (const item of json) {
      const n = normalizeFinding(item);
      if (n) out.push(toCandidate(n, ctx));
    }
    return applySuggestedFixConfidenceGate(out);
  }

  return [];
}

function toCandidate(
  f: {
    title: string;
    body: string;
    path: string;
    startLine?: number;
    endLine?: number;
    symbolId?: string;
    category: string;
    severity: string;
    modelConfidence?: number;
    suggestion?: string;
    suggestedFix?: string;
    existingCode?: string;
    reasoning?: string;
    ruleIds?: string[];
  },
  ctx: ExtractLlmOptions,
): FindingCandidate {
  const modelConfidence = f.modelConfidence;
  const tokenConfidence = ctx.tokenConfidence;
  // Product confidence from evidence; model/token are weak secondaries only.
  const scored = applyProductConfidence({
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    body: f.body,
    modelConfidence,
    tokenConfidence,
    agents: [ctx.role],
  });
  const confidence = scored.confidence ?? 0.5;
  const min = getSuggestedFixMinConfidence();
  const suggestedFix =
    f.suggestedFix?.trim() && confidence + 1e-9 >= min
      ? f.suggestedFix
      : undefined;
  const reasoning = f.reasoning?.trim() || undefined;
  // Dual form: first-class field for verifier + evidence entry for audit/SARIF/store merges
  const evidence = reasoning
    ? [
        {
          id: `reasoning-${ctx.role}-${hashShort(f.title + f.path)}`,
          type: "reasoning" as const,
          summary: reasoning.slice(0, 400),
          payload: {
            role: ctx.role,
            text: reasoning.slice(0, 4_000),
          },
        },
      ]
    : [];

  return {
    title: f.title,
    body: f.body,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    symbolId: f.symbolId,
    category: f.category as FindingCandidate["category"],
    severity: f.severity as FindingCandidate["severity"],
    confidence,
    modelConfidence,
    tokenConfidence,
    suggestion: f.suggestion,
    suggestedFix,
    existingCode: f.existingCode,
    reasoning,
    evidence,
    ruleIds: f.ruleIds ?? [],
    agents: [ctx.role],
    sessionId: ctx.sessionId,
    repoId: ctx.repoId,
  };
}

/** Short stable-ish id fragment (no crypto dep — not security-sensitive). */
function hashShort(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).slice(0, 8);
}

function peelJson(content: string): unknown {
  const trimmed = content.trim();
  // Strip common deep-agent prefixes
  const cleaned = trimmed
    .replace(/^Final answer:\s*/i, "")
    .replace(/^Assistant:\s*/i, "");

  const attempts = [cleaned, trimmed];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      /* continue */
    }
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      /* continue */
    }
  }

  // Find outermost JSON object or array
  const objStart = cleaned.indexOf("{");
  const arrStart = cleaned.indexOf("[");
  let start = -1;
  let end = -1;
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
    end = cleaned.lastIndexOf("}");
  } else if (arrStart >= 0) {
    start = arrStart;
    end = cleaned.lastIndexOf("]");
  }
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // Try to repair trailing commas
      try {
        return JSON.parse(slice.replace(/,\s*([\]}])/g, "$1"));
      } catch {
        return null;
      }
    }
  }
  return null;
}
