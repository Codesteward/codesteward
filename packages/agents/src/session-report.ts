import type {
  ReviewJob,
  ReviewSession,
  ReviewUnit,
  SessionAudit,
  Severity,
} from "@codesteward/core";
import { nowIso } from "@codesteward/core";
import type { ModelRouter } from "@codesteward/model-router";
import { severityCounts } from "./judge.js";

export interface SessionReport {
  /** Full human-readable markdown */
  markdown: string;
  /** Short blurb for lists / headlines (1–3 sentences) */
  headline: string;
  format: "markdown";
  generatedAt: string;
  /** Whether an LLM wrote the executive narrative */
  llmNarrative: boolean;
  mode: string;
  verdict?: string;
  findingCount: number;
  severityCounts: Record<string, number>;
}

export interface BuildSessionReportInput {
  session: ReviewSession;
  job: ReviewJob;
  findings: Array<{
    title: string;
    body?: string;
    path?: string;
    startLine?: number;
    severity: Severity | string;
    category?: string;
    agents?: string[];
    suggestion?: string;
    suggestedFix?: string;
  }>;
  units: ReviewUnit[];
  dropped?: Array<{ title: string; reason: string }>;
  audit?: SessionAudit | null;
  discourseNotes?: number;
  crossRepoRepos?: string[];
  verdict?: string;
  modelRouter?: ModelRouter;
}

function sevRank(s: string): number {
  const order = ["critical", "high", "medium", "low", "info"];
  const i = order.indexOf(s.toLowerCase());
  return i < 0 ? 50 : i;
}

function topFindings(
  findings: BuildSessionReportInput["findings"],
  n = 8,
): BuildSessionReportInput["findings"] {
  return [...findings]
    .sort((a, b) => sevRank(String(a.severity)) - sevRank(String(b.severity)))
    .slice(0, n);
}

function unitSummary(units: ReviewUnit[]): string {
  if (!units.length) return "No review units were planned.";
  const lines = units.map((u) => {
    const err = u.error ? ` — ${u.error.slice(0, 120)}` : "";
    return `- **${u.label}** · ${u.status}${err}`;
  });
  return lines.join("\n");
}

function timingsSection(audit?: SessionAudit | null): string {
  const t = audit?.timings;
  if (!t?.stages?.length && !t?.summary) {
    return "_No stage timings recorded (re-run with current worker)._";
  }
  const lines: string[] = [];
  if (t.totalDurationMs != null) {
    lines.push(`- **Total:** ${(t.totalDurationMs / 1000).toFixed(1)}s`);
  }
  const s = t.summary;
  if (s?.byStageMs && Object.keys(s.byStageMs).length) {
    lines.push("- **By stage:**");
    const ordered = Object.entries(s.byStageMs).sort((a, b) => b[1] - a[1]);
    for (const [stage, ms] of ordered) {
      lines.push(`  - \`${stage}\`: ${(ms / 1000).toFixed(1)}s`);
    }
  }
  if (s?.longestSpecialistRole && s.longestSpecialistMs != null) {
    lines.push(
      `- **Slowest specialist:** \`${s.longestSpecialistRole}\` ${(s.longestSpecialistMs / 1000).toFixed(1)}s`,
    );
  }
  if (s?.longestUnitId && s.longestUnitMs != null) {
    lines.push(
      `- **Slowest unit:** \`${s.longestUnitId}\` ${(s.longestUnitMs / 1000).toFixed(1)}s`,
    );
  }
  if (s?.specialistRunsSumMs != null && s.specialistRunsCount) {
    lines.push(
      `- **Specialist CPU-time sum:** ${(s.specialistRunsSumMs / 1000).toFixed(1)}s across ${s.specialistRunsCount} run(s) (parallel roles overlap)`,
    );
  }
  if (t.units?.length) {
    lines.push("- **Units (wall):**");
    for (const u of t.units.slice(0, 20)) {
      const dur = u.durationMs != null ? `${(u.durationMs / 1000).toFixed(1)}s` : "?";
      lines.push(
        `  - ${u.unitLabel ?? u.unitId}: ${dur}` +
          (u.status ? ` · ${u.status}` : "") +
          (u.specialistMaxMs != null
            ? ` · max specialist ${(u.specialistMaxMs / 1000).toFixed(1)}s`
            : ""),
      );
    }
    if (t.units.length > 20) lines.push(`  - … +${t.units.length - 20} more`);
  }
  return lines.join("\n") || "_Timings present but empty._";
}

function subagentAuditSection(audit?: SessionAudit | null): string {
  const runs = audit?.specialistRuns ?? [];
  if (!runs.length) {
    return "_No specialist run ledger recorded (re-run with current worker for full subagent audit)._";
  }
  const sorted = [...runs].sort(
    (a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0) || a.startedAt.localeCompare(b.startedAt),
  );
  const timedOut = sorted.filter((r) => r.timedOut || r.status === "truncated");
  const header =
    timedOut.length > 0
      ? [
          `> **Coverage incomplete:** ${timedOut.length} specialist run(s) **timed out** ` +
            `(${[...new Set(timedOut.map((r) => r.role))].join(", ")}). ` +
            `Those roles did **not** finish a full review — missing findings must **not** be read as a clean pass for them.`,
          "",
        ].join("\n")
      : "";

  const blocks = sorted.map((r, i) => {
    const step = r.stepIndex != null ? r.stepIndex + 1 : i + 1;
    const dur =
      r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "?";
    const isTimeout = r.timedOut === true || r.status === "truncated";
    const conf = isTimeout
      ? " · **NOT an empty scan (timed out)**"
      : r.avgConfidence != null
        ? (r.findingCount ?? 0) === 0
          ? ` · empty-scan confidence ${(r.avgConfidence * 100).toFixed(0)}%`
          : ` · avg confidence ${(r.avgConfidence * 100).toFixed(0)}%`
        : "";
    const scope =
      r.pathsReviewed?.length
        ? r.pathsReviewed.slice(0, 8).join(", ") +
          (r.pathsReviewed.length > 8 ? "…" : "")
        : r.unitLabel ?? r.unitId;
    const files =
      r.filesReviewed?.length != null
        ? `${r.filesReviewed.length} packed file(s)`
        : null;
    const tools = r.toolCallCount != null ? `${r.toolCallCount} tool call(s)` : null;
    const graph = r.usedGraph ? "graph-grounded" : null;
    const meta = [files, tools, graph].filter(Boolean).join(" · ");
    const findingLines =
      r.findingsSummary?.length
        ? r.findingsSummary
            .slice(0, 8)
            .map((f) => {
              const parts: string[] = [];
              if (f.confidence != null) {
                parts.push(`product=${(f.confidence * 100).toFixed(0)}%`);
              }
              if (f.modelConfidence != null) {
                parts.push(`model=${(f.modelConfidence * 100).toFixed(0)}%`);
              }
              if (f.tokenConfidence != null) {
                parts.push(`token=${(f.tokenConfidence * 100).toFixed(0)}%`);
              }
              const c = parts.length ? ` ${parts.join(" ")}` : "";
              const loc = f.path
                ? ` @ ${f.path}${f.startLine != null ? ":" + f.startLine : ""}`
                : "";
              return `    - [${(f.severity ?? "?").toUpperCase()}${c}] ${f.title}${loc}`;
            })
            .join("\n")
        : r.findingCount
          ? `    - (${r.findingCount} finding(s); titles not retained)`
          : isTimeout
            ? "    - **TIMED OUT — incomplete review (not a clean empty scan)**"
            : "    - _(no findings)_";
    return [
      `### Step ${step}: \`${r.role}\` on **${r.unitLabel ?? r.unitId}**` +
        (isTimeout ? " ⚠️ TIMEOUT" : ""),
      "",
      `- **Status:** ${isTimeout ? "truncated (timeout)" : r.status} · **${dur}**${conf}`,
      r.model ? `- **Model:** \`${r.model}\` (${r.runner})` : `- **Runner:** ${r.runner}`,
      `- **Scope:** ${scope}`,
      meta ? `- **Activity:** ${meta}` : null,
      r.responseSha256
        ? `- **Response integrity:** sha256 \`${r.responseSha256.slice(0, 16)}…\` (${r.completionChars ?? "?"} chars)`
        : null,
      r.error ? `- **Error:** ${r.error.slice(0, 200)}` : null,
      isTimeout
        ? `- **Coverage:** Incomplete for \`${r.role}\` — do not treat missing findings as a clean pass for this role.`
        : null,
      `- **Findings this step:**`,
      findingLines,
      "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return header + blocks.join("\n");
}

function findingsSection(findings: BuildSessionReportInput["findings"]): string {
  if (!findings.length) {
    return "_No findings were retained after judge / noise filtering._";
  }
  const top = topFindings(findings, 12);
  return top
    .map((f, i) => {
      const loc =
        f.path != null
          ? `\`${f.path}${f.startLine != null ? `:${f.startLine}` : ""}\``
          : "_unlocated_";
      const agents = f.agents?.length ? ` · agents: ${f.agents.join(", ")}` : "";
      const body = (f.body ?? "").trim().slice(0, 400);
      const sug = f.suggestion?.trim()
        ? `\n  - **Suggestion:** ${f.suggestion.trim().slice(0, 280)}`
        : "";
      const fix = f.suggestedFix?.trim()
        ? `\n  - **Proposed fix:**\n\`\`\`\n${f.suggestedFix.trim().slice(0, 800)}\n\`\`\``
        : "";
      return (
        `${i + 1}. **[${String(f.severity).toUpperCase()}]** ${f.title}\n` +
        `   - ${loc}${f.category ? ` · ${f.category}` : ""}${agents}\n` +
        (body ? `   - ${body.replace(/\n+/g, " ")}${body.length >= 400 ? "…" : ""}` : "") +
        sug +
        fix
      );
    })
    .join("\n\n");
}

function countsLine(counts: Record<string, number>): string {
  const keys = ["critical", "high", "medium", "low", "info"];
  const parts = keys
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`);
  const other = Object.entries(counts)
    .filter(([k]) => !keys.includes(k))
    .map(([k, v]) => `${v} ${k}`);
  return [...parts, ...other].join(", ") || "none";
}

function provenanceLine(audit?: SessionAudit | null, job?: ReviewJob): string {
  if (!audit?.context) {
    return job?.repoPath
      ? `Workspace path: \`${job.repoPath}\` (full audit not available).`
      : "Code provenance not recorded for this run.";
  }
  const c = audit.context;
  const bits = [
    `source **${c.source}**`,
    c.verified ? "SHA verified" : "SHA not verified",
    c.repoPath ? `path \`${c.repoPath}\`` : null,
    c.filesIncluded?.length
      ? `${c.filesIncluded.length} file(s) in specialist context`
      : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Deterministic, always-on human report (no LLM required).
 */
export function buildSessionReportMarkdown(input: BuildSessionReportInput): {
  markdown: string;
  headline: string;
} {
  const {
    session,
    job,
    findings,
    units,
    dropped = [],
    audit,
    discourseNotes = 0,
    crossRepoRepos = [],
    verdict,
  } = input;
  const counts = severityCounts(
    findings.map((f) => ({ severity: f.severity as Severity })),
  );
  const v = verdict ?? session.verdict ?? "unknown";
  const modeLabel = session.mode === "stewardship" ? "Stewardship review" : "PR gate review";
  const highish =
    (counts.critical ?? 0) + (counts.high ?? 0) + (counts.medium ?? 0);

  let headline: string;
  if (session.status === "failed") {
    headline = `${modeLabel} of **${session.repoId}** failed before a clean finish.`;
  } else if (!findings.length) {
    headline =
      `${modeLabel} of **${session.repoId}** completed with **no retained findings** ` +
      `(verdict: **${v}**).`;
  } else {
    headline =
      `${modeLabel} of **${session.repoId}** finished with **${findings.length} finding(s)** ` +
      `(${countsLine(counts)}; verdict: **${v}**).`;
  }

  const scope =
    job.paths?.length && !(job.paths.length === 1 && job.paths[0] === ".")
      ? job.paths.join(", ")
      : session.mode === "gate"
        ? "PR / changed paths"
        : "repository paths (full or filtered stewardship)";

  const md = [
    `# Codesteward ${modeLabel}`,
    "",
    `**Repository:** \`${session.repoId}\`  `,
    `**Session:** \`${session.id}\`  `,
    `**Mode / tier / depth:** ${session.mode} · ${session.riskTier} · ${session.depth}  `,
    `**Verdict:** **${v}**  `,
    `**Completed:** ${session.completedAt ?? nowIso()}  `,
    session.baseBranch || session.headBranch
      ? `**Branches:** ${session.baseBranch ?? "?"} → ${session.headBranch ?? "?"}`
      : null,
    session.prNumber != null ? `**PR:** #${session.prNumber}` : null,
    "",
    "## Executive summary",
    "",
    headline.replace(/\*\*/g, ""),
    "",
    highish > 0
      ? `Focus first on **critical/high/medium** items (${highish} in those bands). Lower-severity notes can wait for a later pass.`
      : findings.length
        ? "Remaining items are lower severity; treat as backlog polish unless policy requires them for merge."
        : session.mode === "stewardship"
          ? "This stewardship pass did not surface durable issues above the severity floor. Consider a deeper tier or broader path set if you expected more coverage."
          : "Gate did not block on retained findings.",
    "",
    "## What was reviewed",
    "",
    `- **Scope:** ${scope}`,
    `- **Provenance:** ${provenanceLine(audit, job)}`,
    crossRepoRepos.length
      ? `- **Cross-repo units:** ${crossRepoRepos.join(", ")}`
      : null,
    audit?.specialistRuns?.length
      ? `- **Specialist runs:** ${audit.specialistRuns.length} (${audit.specialistRuns.map((r) => r.role).join(", ")})`
      : `- **Units:** ${units.length}`,
    discourseNotes > 0 ? `- **Discourse notes:** ${discourseNotes}` : null,
    audit?.timings?.totalDurationMs != null
      ? `- **Wall time:** ${(audit.timings.totalDurationMs / 1000).toFixed(1)}s` +
        (audit.timings.summary?.longestStage
          ? ` (longest stage: **${audit.timings.summary.longestStage}** ${(audit.timings.summary.longestStageMs! / 1000).toFixed(1)}s)`
          : "")
      : null,
    "",
    "## Timing / bottlenecks",
    "",
    timingsSection(audit),
    "",
    "## Unit outcomes",
    "",
    unitSummary(units),
    "",
    "## Subagent / specialist audit trail",
    "",
    subagentAuditSection(audit),
    "",
    "## Findings",
    "",
    findingsSection(findings),
    "",
    dropped.length
      ? [
          "## Filtered / dropped by judge",
          "",
          `_${dropped.length} candidate(s) removed_ (noise floor, dedupe, or learning).`,
          ...dropped.slice(0, 15).map((d) => `- ${d.title} — ${d.reason}`),
          dropped.length > 15 ? `- …and ${dropped.length - 15} more` : null,
          "",
        ]
          .filter(Boolean)
          .join("\n")
      : null,
    "## Recommended next steps",
    "",
    findings.length
      ? [
          "1. Triage **critical/high** findings first; confirm path/line still match HEAD.",
          "2. Apply suggested fixes or track them as tickets with the finding fingerprint.",
          "3. Re-run gate or stewardship after changes to confirm convergence.",
          session.mode === "stewardship"
            ? "4. Optionally expand paths or raise depth/tier for areas not covered in this pack."
            : "4. Ensure CI still requires the Codesteward check if this is a merge gate.",
        ].join("\n")
      : [
          "1. If this was a smoke run, re-run with broader paths or `riskTier: full|thorough`.",
          "2. Confirm provenance is **clone** (or verified mount) for remote repos.",
          "3. Keep feedback reactions on future findings so learning can suppress noise.",
        ].join("\n"),
    "",
    "---",
    "",
    `_Generated by Codesteward · session \`${session.id}\`_`,
    "",
  ]
    .filter((line) => line != null)
    .join("\n");

  return { markdown: md, headline: headline.replace(/\*\*/g, "") };
}

/**
 * Optional LLM narrative prepended as "## Narrative" for stewardship / thorough runs.
 */
export async function enhanceReportWithLlm(
  base: { markdown: string; headline: string },
  input: BuildSessionReportInput,
): Promise<{ markdown: string; headline: string; llmNarrative: boolean }> {
  const enabled = process.env.STEW_SESSION_REPORT_LLM !== "0";
  const wantLlm =
    enabled &&
    input.modelRouter &&
    (input.session.mode === "stewardship" ||
      input.session.riskTier === "thorough" ||
      input.session.depth === "thorough" ||
      process.env.STEW_SESSION_REPORT_LLM === "1");
  if (!wantLlm || !input.modelRouter) {
    return { ...base, llmNarrative: false };
  }

  try {
    const model = input.modelRouter.createChatModel("judge");
    const counts = severityCounts(
      input.findings.map((f) => ({ severity: f.severity as Severity })),
    );
    const digest = topFindings(input.findings, 6)
      .map(
        (f) =>
          `- [${f.severity}] ${f.title} (${f.path ?? "?"}${f.startLine != null ? ":" + f.startLine : ""})`,
      )
      .join("\n");
    const res = await model.complete({
      messages: [
        {
          role: "system",
          content:
            "You write concise engineering review reports for developers and engineering managers. " +
            "Use plain professional prose. No JSON. 2–4 short paragraphs max. " +
            "Do not invent findings not listed. Mention verdict and what to do next.",
        },
        {
          role: "user",
          content: [
            `Repo: ${input.session.repoId}`,
            `Mode: ${input.session.mode} (${input.session.riskTier}/${input.session.depth})`,
            `Verdict: ${input.verdict ?? input.session.verdict ?? "unknown"}`,
            `Finding counts: ${JSON.stringify(counts)}`,
            `Headline: ${base.headline}`,
            `Top findings:\n${digest || "(none)"}`,
            "",
            "Write an executive narrative for the review report.",
          ].join("\n"),
        },
      ],
      maxTokens: 600,
      temperature: 0.2,
    });
    const narrative = (res.content ?? "").trim();
    if (!narrative || narrative.length < 40) {
      return { ...base, llmNarrative: false };
    }
    const markdown = base.markdown.replace(
      "## Executive summary\n\n",
      `## Executive summary\n\n${narrative}\n\n### Snapshot\n\n`,
    );
    // Prefer first sentence of LLM as headline when short enough
    const first = narrative.split(/(?<=[.!?])\s+/)[0] ?? base.headline;
    const headline =
      first.length > 20 && first.length < 280 ? first : base.headline;
    return { markdown, headline, llmNarrative: true };
  } catch {
    return { ...base, llmNarrative: false };
  }
}

export async function buildSessionReport(
  input: BuildSessionReportInput,
): Promise<SessionReport> {
  const base = buildSessionReportMarkdown(input);
  const enhanced = await enhanceReportWithLlm(base, input);
  const counts = severityCounts(
    input.findings.map((f) => ({ severity: f.severity as Severity })),
  );
  return {
    markdown: enhanced.markdown,
    headline: enhanced.headline,
    format: "markdown",
    generatedAt: nowIso(),
    llmNarrative: enhanced.llmNarrative,
    mode: input.session.mode,
    verdict: input.verdict ?? input.session.verdict,
    findingCount: input.findings.length,
    severityCounts: counts,
  };
}

