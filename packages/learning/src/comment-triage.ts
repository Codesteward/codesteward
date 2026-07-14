/**
 * Cheap-model triage for PR comments that mention CodeSteward.
 * Extracts learning intent (org/repo/PR scoped) vs re-review focus vs ignore.
 */
import type { LearningScope } from "./types.js";

export type CommentTriageIntent = "review" | "learn" | "ignore" | "clarify";

export interface CommentTriageLearning {
  title: string;
  body: string;
  polarity: "positive" | "negative";
  scope: LearningScope;
  kind?: "preference" | "dismissal" | "pattern" | "false_positive";
}

export interface CommentTriageResult {
  intent: CommentTriageIntent;
  /** When intent is learn (or dual review+learn). */
  learning?: CommentTriageLearning;
  /** Free-text focus for a re-review run. */
  reviewFocus?: string;
  /** Optional short reply to post on the PR. */
  reply?: string;
  /** Raw model confidence 0–1 if available. */
  confidence?: number;
}

export interface CommentTriageInput {
  commentBody: string;
  repoId: string;
  prNumber: number;
  author?: string;
  prTitle?: string;
}

export interface CheapModelComplete {
  complete(req: {
    model?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content?: string; text?: string }>;
  /** Prefer STEW_MODEL_CHEAP / role summary when available. */
  resolveCheapModel?: () => string | undefined;
}

const TRIAGE_SYSTEM = `You classify developer comments on pull requests that mention a code-review bot (CodeSteward).
Return ONLY compact JSON (no markdown fences) with this shape:
{
  "intent": "review" | "learn" | "ignore" | "clarify",
  "learning": {
    "title": "short title",
    "body": "what to remember",
    "polarity": "positive" | "negative",
    "scope": "org" | "repo" | "pr",
    "kind": "preference" | "dismissal" | "pattern" | "false_positive"
  } | null,
  "reviewFocus": "optional focus for a re-review" | null,
  "reply": "optional short acknowledgement" | null,
  "confidence": 0.0-1.0
}

Rules:
- intent=learn when the user teaches a preference, dismissal, false positive, or deferred work.
- scope=org for org-wide policy ("never flag import order", "we always use Zod").
- scope=repo for repo-specific conventions.
- scope=pr when the note applies only to THIS PR (e.g. "don't implement X here — follow-up PR", "ignore this finding for now").
- intent=review when they want a re-review or focused review; put focus in reviewFocus.
- intent can be review AND learning: prefer intent=review and still fill learning when both apply.
- intent=ignore for noise, thanks, emoji, bot echoes.
- intent=clarify when the message is ambiguous and a short clarifying question is needed (put question in reply).
- polarity=negative for suppress/dismiss/wontfix; positive for reinforce/focus.
- Keep title ≤ 120 chars; body ≤ 500 chars.`;

/**
 * Heuristic fallback when no model is configured.
 */
export function triageCommentHeuristic(input: CommentTriageInput): CommentTriageResult {
  const raw = input.commentBody.trim();
  const body = raw.toLowerCase();
  const mention =
    body.includes("@codesteward") ||
    body.includes("codesteward") ||
    Boolean(process.env.STEW_MENTION_TOKEN && body.includes(process.env.STEW_MENTION_TOKEN.toLowerCase()));

  // Strip mention for content checks
  const content = raw
    .replace(/@codesteward/gi, "")
    .replace(/codesteward/gi, "")
    .trim();

  if (!content || content.length < 3) {
    return { intent: "ignore", confidence: 0.9 };
  }

  const wantsReview =
    /\b(re-?review|review\s+(again|this|please)|please\s+review|check\s+again|look\s+again)\b/i.test(
      content,
    ) ||
    (mention && /\breview\b/i.test(content));

  const learnSignals =
    /\b(never|always|don't|do not|stop|ignore|false\s*positive|not\s+a\s+bug|wont\s*fix|won't\s*fix|prefer|we\s+use|org[- ]wide|for\s+this\s+pr|follow[- ]?up\s+pr|defer|later\s+pr|out\s+of\s+scope)\b/i.test(
      content,
    );

  const prOnly =
    /\b(this\s+pr|for\s+this\s+pr|out\s+of\s+scope|follow[- ]?up|defer|later\s+pr|another\s+pr)\b/i.test(
      content,
    );
  const orgWide = /\b(org[- ]wide|all\s+repos|everywhere|company[- ]wide)\b/i.test(content);
  const dismiss =
    /\b(false\s*positive|ignore|not\s+a\s+bug|noise|wont\s*fix|won't\s*fix|stop\s+flagging|don'?t\s+(implement|flag|report)|do\s+not\s+(implement|flag|report)|out\s+of\s+scope|defer|follow[- ]?up)\b/i.test(
      content,
    );

  if (learnSignals) {
    const scope: LearningScope = prOnly ? "pr" : orgWide ? "org" : "repo";
    // PR-only deferrals and suppressions are negative; other learnings default positive.
    const polarity = dismiss || prOnly ? "negative" : "positive";
    return {
      intent: wantsReview ? "review" : "learn",
      learning: {
        title: content.slice(0, 120),
        body: content.slice(0, 500),
        polarity,
        scope,
        kind: polarity === "negative" ? "dismissal" : "preference",
      },
      reviewFocus: wantsReview ? content.slice(0, 300) : undefined,
      reply: scope === "pr"
        ? "Noted for this PR only."
        : scope === "org"
          ? "Saved as org-wide learning."
          : "Saved as repo learning.",
      confidence: 0.55,
    };
  }

  if (wantsReview) {
    return {
      intent: "review",
      reviewFocus: content.slice(0, 300),
      confidence: 0.7,
    };
  }

  if (mention && content.length > 10) {
    return {
      intent: "clarify",
      reply:
        "I can re-review this PR or save a learning (org / repo / this PR). Reply with e.g. `@codesteward review` or `@codesteward never flag …`.",
      confidence: 0.4,
    };
  }

  return { intent: "ignore", confidence: 0.6 };
}

function parseTriageJson(text: string): CommentTriageResult | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    const intent = obj.intent;
    if (
      intent !== "review" &&
      intent !== "learn" &&
      intent !== "ignore" &&
      intent !== "clarify"
    ) {
      return null;
    }
    let learning: CommentTriageLearning | undefined;
    if (obj.learning && typeof obj.learning === "object") {
      const L = obj.learning as Record<string, unknown>;
      const scope = L.scope === "org" || L.scope === "repo" || L.scope === "pr" ? L.scope : "repo";
      const polarity = L.polarity === "positive" ? "positive" : "negative";
      learning = {
        title: String(L.title ?? "Learning").slice(0, 120),
        body: String(L.body ?? L.title ?? "").slice(0, 500),
        polarity,
        scope,
        kind:
          L.kind === "dismissal" ||
          L.kind === "pattern" ||
          L.kind === "false_positive" ||
          L.kind === "preference"
            ? L.kind
            : polarity === "negative"
              ? "dismissal"
              : "preference",
      };
    }
    return {
      intent,
      learning,
      reviewFocus: typeof obj.reviewFocus === "string" ? obj.reviewFocus.slice(0, 400) : undefined,
      reply: typeof obj.reply === "string" ? obj.reply.slice(0, 400) : undefined,
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Triage a PR comment with the cheap model; falls back to heuristics.
 */
export async function triagePrComment(
  input: CommentTriageInput,
  model?: CheapModelComplete | null,
): Promise<CommentTriageResult> {
  if (!model) {
    return triageCommentHeuristic(input);
  }

  try {
    const cheap = model.resolveCheapModel?.();
    const res = await model.complete({
      model: cheap,
      temperature: 0,
      maxTokens: 400,
      messages: [
        { role: "system", content: TRIAGE_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            repoId: input.repoId,
            prNumber: input.prNumber,
            author: input.author,
            prTitle: input.prTitle,
            comment: input.commentBody.slice(0, 2000),
          }),
        },
      ],
    });
    const text = res.content ?? res.text ?? "";
    const parsed = parseTriageJson(text);
    if (parsed) return parsed;
  } catch (err) {
    console.warn(
      "[learning] comment triage model failed, using heuristic:",
      err instanceof Error ? err.message : err,
    );
  }
  return triageCommentHeuristic(input);
}
