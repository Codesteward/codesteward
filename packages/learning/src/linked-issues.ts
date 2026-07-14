/**
 * Parse GitHub-style linked issue references from PR bodies / commit messages
 * and format them for review context.
 */

export interface LinkedIssueRef {
  number: number;
  /** Keyword that linked it: fixes, closes, resolves, refs, etc. */
  keyword: string;
}

export interface FetchedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url?: string;
  labels?: string[];
}

/** Match Fixes #12, closes #3, Resolves: org/repo#9, etc. */
const LINK_RE =
  /\b(fix(?:es|ed)?|close[sd]?|resolve[sd]?|ref(?:erence)?s?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;

/** Also bare "Related to #4" / "See #7" */
const LOOSE_RE = /\b(?:related\s+to|see|tracked\s+by|part\s+of)\s+#(\d+)\b/gi;

export function parseLinkedIssueRefs(text: string | undefined | null): LinkedIssueRef[] {
  if (!text) return [];
  const seen = new Set<number>();
  const out: LinkedIssueRef[] = [];

  for (const m of text.matchAll(LINK_RE)) {
    const keyword = (m[1] ?? "refs").toLowerCase();
    const number = Number(m[2]);
    if (!Number.isFinite(number) || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, keyword });
  }
  for (const m of text.matchAll(LOOSE_RE)) {
    const number = Number(m[1]);
    if (!Number.isFinite(number) || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, keyword: "related" });
  }
  return out;
}

/**
 * Build a prompt block from fetched issues (title + truncated body).
 */
export function formatLinkedIssuesContext(
  issues: FetchedIssue[],
  opts?: { maxChars?: number; maxBodyPerIssue?: number },
): string {
  if (!issues.length) return "";
  const maxChars = opts?.maxChars ?? 4000;
  const maxBody = opts?.maxBodyPerIssue ?? 800;
  const lines: string[] = [
    "# Linked issues (from PR body — treat as product context)",
    "These issues are referenced by the PR (Fixes/Closes/Resolves/related). Align findings with the stated problem; do not re-litigate out-of-scope work.",
  ];
  for (const issue of issues) {
    lines.push("");
    lines.push(
      `## #${issue.number} ${issue.title} (${issue.state})${issue.url ? ` — ${issue.url}` : ""}`,
    );
    if (issue.labels?.length) {
      lines.push(`Labels: ${issue.labels.join(", ")}`);
    }
    const body = (issue.body ?? "").trim();
    if (body) {
      lines.push(body.length > maxBody ? body.slice(0, maxBody) + "…" : body);
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n… (linked issues truncated)";
  }
  return text;
}

/**
 * Fetch issues for refs using an SCM-like getIssue callback.
 */
export async function loadLinkedIssues(
  refs: LinkedIssueRef[],
  getIssue: (number: number) => Promise<FetchedIssue | null | undefined>,
  opts?: { maxIssues?: number },
): Promise<FetchedIssue[]> {
  const max = opts?.maxIssues ?? 5;
  const out: FetchedIssue[] = [];
  for (const ref of refs.slice(0, max)) {
    try {
      const issue = await getIssue(ref.number);
      if (issue) out.push(issue);
    } catch {
      /* skip missing / private */
    }
  }
  return out;
}
