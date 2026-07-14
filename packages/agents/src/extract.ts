import {
  CategorySchema,
  SeveritySchema,
  type AgentRole,
  type FindingCandidate,
} from "@codesteward/core";
import { z } from "zod";

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
    // Models often return 0–100 or strings
    confidence: z.union([z.number(), z.string()]).optional(),
    suggestion: z.string().optional(),
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

function normalizeFinding(raw: unknown): {
  title: string;
  body: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  category: string;
  severity: string;
  confidence?: number;
  suggestion?: string;
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
        confidence: asConfidence(o.confidence),
        suggestion: typeof o.suggestion === "string" ? o.suggestion : undefined,
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
    confidence: asConfidence(f.confidence),
    suggestion: f.suggestion,
    ruleIds,
  };
}

/** Extract structured findings from LLM JSON (or fenced / noisy tool output). */
export function extractFindingsFromLlm(
  content: string,
  ctx: { role: AgentRole; sessionId?: string; repoId?: string },
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
      return out;
    }
    // single finding object
    const one = normalizeFinding(json);
    if (one) return [toCandidate(one, ctx)];
  }

  if (Array.isArray(json)) {
    const out: FindingCandidate[] = [];
    for (const item of json) {
      const n = normalizeFinding(item);
      if (n) out.push(toCandidate(n, ctx));
    }
    return out;
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
    confidence?: number;
    suggestion?: string;
    ruleIds?: string[];
  },
  ctx: { role: AgentRole; sessionId?: string; repoId?: string },
): FindingCandidate {
  return {
    title: f.title,
    body: f.body,
    path: f.path,
    startLine: f.startLine,
    endLine: f.endLine,
    symbolId: f.symbolId,
    category: f.category as FindingCandidate["category"],
    severity: f.severity as FindingCandidate["severity"],
    confidence: f.confidence ?? 0.7,
    suggestion: f.suggestion,
    ruleIds: f.ruleIds ?? [],
    agents: [ctx.role],
    sessionId: ctx.sessionId,
    repoId: ctx.repoId,
  };
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
