import { createHash } from "node:crypto";
import type { Category } from "./enums.js";

/**
 * Stable finding fingerprint for dedupe across sessions.
 * fingerprint = sha256(path|category|ruleId|snippetHash|symbolId)
 */
export function computeFingerprint(input: {
  path: string;
  category: Category | string;
  ruleId?: string;
  snippet?: string;
  symbolId?: string;
}): string {
  const path = normalizePath(input.path);
  const snippetHash = input.snippet
    ? createHash("sha256").update(normalizeSnippet(input.snippet)).digest("hex").slice(0, 16)
    : "";
  const raw = [
    path,
    input.category,
    input.ruleId ?? "",
    snippetHash,
    input.symbolId ?? "",
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
