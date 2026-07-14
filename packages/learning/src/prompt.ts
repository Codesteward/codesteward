import type { LearningStore } from "./store.js";
import type { LearningScope, OrgMemory } from "./types.js";
import { inferMemoryScope, makePrKey } from "./types.js";

export interface LearningPromptOptions {
  orgId?: string;
  repoId?: string;
  /** PR number — used with repoId to form prKey when prKey is not set. */
  prNumber?: number;
  /** Explicit PR key (`repoId#number`). */
  prKey?: string;
  /** Cap negative items (default 30). */
  maxNegative?: number;
  /** Cap positive items (default 15). */
  maxPositive?: number;
  /** Max total characters for the block (default 6000). */
  maxChars?: number;
}

const SCOPE_RANK: Record<LearningScope, number> = {
  pr: 0,
  repo: 1,
  org: 2,
};

/**
 * Build model-side learning guidance from org / repo / PR memories + downvotes.
 * Injected into specialist / discourse system prompts so the LLM avoids
 * re-proposing dismissed noise and steers toward preferences —
 * not only post-hoc judge filtering.
 *
 * Hierarchy (most specific first): PR → repo → org-wide.
 */
export async function buildOrgLearningPrompt(
  store: LearningStore,
  opts: LearningPromptOptions = {},
): Promise<string> {
  const orgId = opts.orgId ?? "local";
  const maxNeg = opts.maxNegative ?? 30;
  const maxPos = opts.maxPositive ?? 15;
  const maxChars = opts.maxChars ?? 6000;
  const prKey =
    opts.prKey ??
    (opts.repoId && opts.prNumber != null
      ? makePrKey(opts.repoId, opts.prNumber)
      : undefined);

  const memories = await store.listMemories({
    orgId,
    repoId: opts.repoId,
    prKey,
    applicable: true,
  });

  const sorted = [...memories].sort((a, b) => {
    const as = SCOPE_RANK[inferMemoryScope(a)] ?? 2;
    const bs = SCOPE_RANK[inferMemoryScope(b)] ?? 2;
    if (as !== bs) return as - bs;
    return (b.weight ?? 0) - (a.weight ?? 0);
  });

  const negative = sorted.filter((m) => m.polarity !== "positive").slice(0, maxNeg);
  const positive = sorted.filter((m) => m.polarity === "positive").slice(0, maxPos);

  // Also fold fingerprint-only downvotes not yet mirrored as memories
  let reactionLines: string[] = [];
  try {
    const rx = await store.listReactions({ orgId, repoId: opts.repoId });
    const seenFp = new Set(negative.map((m) => m.fingerprint).filter(Boolean));
    for (const r of rx) {
      if (r.reaction !== "down" || !r.fingerprint || seenFp.has(r.fingerprint)) continue;
      seenFp.add(r.fingerprint);
      reactionLines.push(
        `- [downvote] fingerprint=${r.fingerprint.slice(0, 20)}…${r.note ? ` note=${r.note.slice(0, 120)}` : ""}`,
      );
      if (reactionLines.length >= 15) break;
    }
  } catch {
    /* optional */
  }

  if (!negative.length && !positive.length && !reactionLines.length) {
    return "";
  }

  const lines: string[] = [
    "# Org learning (user feedback — treat as hard policy for this review)",
    "These come from 👍/👎 reactions, status changes (wontfix / false_positive / dismissed), PR comments, and explicit memories.",
    "Scopes: **pr** (this PR only) → **repo** (this repository) → **org** (all repos). Prefer more specific scopes when they conflict.",
    "They apply only to this org; never invent feedback from other tenants.",
  ];

  if (negative.length || reactionLines.length) {
    lines.push("");
    lines.push("## Suppress / do not re-report (noise, false positives, wontfix, deferred)");
    lines.push(
      "Do NOT emit findings that match these themes, titles, paths, or fingerprints. If something is borderline-related, lower confidence or omit it.",
    );
    for (const m of negative) {
      lines.push(formatMemoryLine(m));
    }
    for (const r of reactionLines) lines.push(r);
  }

  if (positive.length) {
    lines.push("");
    lines.push("## Prefer / emphasize (focus areas)");
    lines.push(
      "Weight review effort toward these areas when they appear in scope. Prefer high-signal findings that align with them.",
    );
    for (const m of positive) {
      lines.push(formatMemoryLine(m));
    }
  }

  lines.push("");
  lines.push(
    "When learning conflicts with a weak stylistic nit, drop the nit. When it conflicts with a clear critical security bug that is not listed above, still report the critical bug.",
  );

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n… (org learning truncated by budget)";
  }
  return text;
}

function formatMemoryLine(m: OrgMemory): string {
  const scope = inferMemoryScope(m);
  const title = (m.title ?? m.pattern ?? m.body ?? m.fingerprint ?? m.kind).slice(0, 160);
  const bits = [`- [${scope}/${m.kind}/${m.polarity}] ${title}`];
  if (scope === "repo" && m.repoId) bits.push(`  repo: ${m.repoId}`);
  if (scope === "pr" && m.prKey) bits.push(`  pr: ${m.prKey}`);
  if (m.pattern && m.pattern !== m.title) bits.push(`  match: ${m.pattern.slice(0, 160)}`);
  if (m.fingerprint) bits.push(`  fingerprint: ${m.fingerprint.slice(0, 24)}…`);
  if (m.source) bits.push(`  source: ${m.source}`);
  if (m.body && m.body !== m.title) bits.push(`  detail: ${m.body.slice(0, 180)}`);
  return bits.join("\n");
}
